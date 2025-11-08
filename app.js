// app.js
// 最終仕様実装版
// - 因子 0..6
// - 装備レベルは地層ごとに選択可能（有効） -> 選択すると再計算
// - 掘削完了までのターン数シミュレーション（最大8ターン）
// - 地層またぎルール（CEIL/FLOOR）に準拠

/* ---------- ユーティリティ ---------- */
async function fetchText(path){
  const res = await fetch(path);
  if(!res.ok) throw new Error('Failed to load ' + path);
  return await res.text();
}
function parseCSV(text){
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(',').map(h=>h.trim());
  return lines.slice(1).map(line=>{
    const cols = line.split(',').map(c=>c.trim());
    const obj = {};
    headers.forEach((h,i)=> obj[h]=cols[i]===undefined? '': cols[i]);
    return obj;
  });
}
function floor(v){ return Math.floor(v); }
function ceil(v){ return Math.ceil(v); }

/* ---------- グローバルデータ ---------- */
const DATA = { gensen:[], rank:[], factor:[], equip:[] };

/* ---------- 初期化 ---------- */
async function init(){
  try{
    DATA.gensen = parseCSV(await fetchText('data/gensen.csv'));
    DATA.rank = parseCSV(await fetchText('data/rank.csv'));
    DATA.factor = parseCSV(await fetchText('data/factor.csv'));
    DATA.equip = parseCSV(await fetchText('data/equip.csv'));
  }catch(e){
    alert('データ読み込みに失敗しました: ' + e.message);
    console.error(e);
    return;
  }
  buildUI();
  attachListeners();
  loadMemo();
  computeAndRender();
  updateDefaultRemaining();
}

/* ---------- UI 構築 ---------- */
const RANK_ORDER = ['G','F','E','D','C','B','A','S','SS','UG'];
const STAT_KEYS = ['speed','stamina','power','guts','wit'];
const LAYER_LABELS_JP = { sand:'砂', ground:'土', rock:'岩' };

function buildUI(){
  // rank selects
  document.querySelectorAll('.rank-select').forEach(s=>{
    RANK_ORDER.forEach(r=>{
      const opt = document.createElement('option'); opt.value=r; opt.textContent=r; s.appendChild(opt);
    });
    s.value='G';
  });

  // factor selects 0..6
  document.querySelectorAll('.factor-select').forEach(s=>{
    for(let i=0;i<=6;i++){
      const opt = document.createElement('option'); opt.value=i; opt.textContent=i; s.appendChild(opt);
    }
    s.value=0;
  });

  // gensen select
  const gsel = document.getElementById('gensen-select');
  DATA.gensen.forEach(row=>{
    const opt = document.createElement('option'); opt.value=row.gensen; opt.textContent=row.gensen; gsel.appendChild(opt);
  });
}

/* ---------- イベント ---------- */
function attachListeners(){
  // general inputs (recompute on change)
  document.querySelectorAll('.rank-select, .factor-select, input[type="checkbox"]').forEach(el=>{
    el.addEventListener('change', ()=>{ computeAndRender(); updateDefaultRemaining(); });
  });

  document.getElementById('gensen-select').addEventListener('change', ()=>{ showGensenInfo(); computeAndRender(); updateDefaultRemaining(); });
  document.getElementById('memo-clear').addEventListener('click', ()=>{ document.getElementById('user-memo').value=''; saveMemo(); });
  document.getElementById('user-memo').addEventListener('input', saveMemo);
  document.getElementById('current-remaining').addEventListener('input', ()=>{ computeAndRender(); computeTurnsSection(); });
}

/* ---------- 源泉表示 ---------- */
function showGensenInfo(){
  const name = document.getElementById('gensen-select').value;
  const found = DATA.gensen.find(r=>r.gensen===name);
  const nameEl = document.getElementById('gensen-name');
  const sandEl = document.getElementById('gensen-sand');
  const groundEl = document.getElementById('gensen-ground');
  const rockEl = document.getElementById('gensen-rock');
  const totalEl = document.getElementById('gensen-total');
  const imgBox = document.getElementById('gensen-image-placeholder');

  if(!found){
    nameEl.textContent=''; sandEl.textContent='-'; groundEl.textContent='-'; rockEl.textContent='-'; totalEl.textContent='-';
    imgBox.innerHTML='画像'; return;
  }
  nameEl.textContent = found.gensen;
  const sand = Number(found.sand)||0;
  const ground = Number(found.ground)||0;
  const rock = Number(found.rock)||0;
  sandEl.textContent=sand; groundEl.textContent=ground; rockEl.textContent=rock; totalEl.textContent=(sand+ground+rock);

  const slug = slugify(found.gensen);
  const imgPath = `images/${slug}.png`;
  imgBox.innerHTML='';
  const img = document.createElement('img');
  img.src = imgPath; img.alt = found.gensen;
  img.onload = ()=>{};
  img.onerror = ()=>{ imgBox.textContent='画像なし'; };
  imgBox.appendChild(img);
}
function slugify(s){ return s.toLowerCase().replace(/[^\w\u3040-\u30ff\u4e00-\u9fff]+/g,'-').replace(/^-+|-+$/g,''); }

/* ---------- CSV 検索ユーティリティ ---------- */
function getRankRow(rank){ return DATA.rank.find(r=>r.rank===rank); }
function getEquipAdjustment(level){ const row = DATA.equip.find(r=> Number(r.equip_level) === Number(level)); return row ? Number(row.equip_adjustment) : 0; }
function getFactorRow(statKey){ return DATA.factor.find(r=> r.status === statKey); }

/* ---------- 掘削力計算 ---------- */
const RANK_MAP = {
  speed: { sand:'high', ground:'middle' },
  stamina: { sand:'low', rock:'low' },
  power: { ground:'low', rock:'high' },
  guts: { ground:'high' },
  wit: { sand:'middle', rock:'middle' }
};
const LINK_TO_LAYER = { teio:'sand', bourbon:'ground', tran:'ground', tarmae:'rock', acute:'rock' };
const BASES = { practice:25, rest:15, pr:10 };

// calcDiggingPowerForLayer(layer, equipAdj)
function calcDiggingPowerForLayer(layer, equipAdj){
  let baseBonusSum = 0;
  STAT_KEYS.forEach(statKey=>{
    const selectId = { speed:'rank-speed', stamina:'rank-stamina', power:'rank-power', guts:'rank-guts', wit:'rank-wit' }[statKey];
    const rank = document.getElementById(selectId).value;
    const mapping = RANK_MAP[statKey];
    const tier = mapping && mapping[layer] ? mapping[layer] : null;
    if(!tier) return;
    const rankRow = getRankRow(rank);
    if(!rankRow) return;
    const colName = { high:'bonus_high', middle:'bonus_middle', low:'bonus_low' }[tier];
    baseBonusSum += Number(rankRow[colName]||0);
  });

  let factorSum = 0;
  STAT_KEYS.forEach(statKey=>{
    const selectId = { speed:'factor-speed', stamina:'factor-stamina', power:'factor-power', guts:'factor-guts', wit:'factor-wit' }[statKey];
    const cnt = Number(document.getElementById(selectId).value) || 0;
    if(cnt <= 0) return;
    const factorRow = getFactorRow(statKey);
    if(!factorRow) return;
    const per = Number(factorRow[layer]||0);
    factorSum += per * cnt;
  });

  let linkBonus = 0;
  [['link-teio','teio'],['link-bourbon','bourbon'],['link-tran','tran'],['link-tarmae','tarmae'],['link-acute','acute']].forEach(([elId,key])=>{
    const el = document.getElementById(elId);
    if(el && el.checked && LINK_TO_LAYER[key] === layer) linkBonus += 10;
  });

  const total = baseBonusSum + factorSum + linkBonus + (Number(equipAdj)||0);
  return { total, baseBonusSum, factorSum, linkBonus, equipAdj };
}

/* ---------- 地層またぎ掘削（1ターン） ---------- */
/*
ルール:
 - baseTotal = base + supportN
 - layer order: sand -> ground -> rock
 - For each layer (starting from the first with remain>0):
    potential = FLOOR(baseTotal * (100 + p)/100)
    if potential <= remain[layer]:
      dug = potential; remain[layer] -= potential; done
    else:
      baseNeeded = CEIL(remain[layer] * 100 / (100 + p))
      baseLeft = max(0, baseTotal - baseNeeded)
      dug += remain[layer]; set remain[layer]=0; baseTotal = baseLeft; continue to next layer
 - returns dug and remainAfter
*/
function oneTurnDig(layersRemain, base, supportN, layerPowers){
  const remain = { sand: layersRemain.sand, ground: layersRemain.ground, rock: layersRemain.rock };
  let baseTotal = base + supportN;
  let totalDug = 0;
  const order = ['sand','ground','rock'];
  let idx = 0;
  while(idx < order.length && (remain[order[idx]] === 0 || remain[order[idx]] <= 0)) idx++;
  if(idx >= order.length) return { dug:0, remainAfter: remain };

  for(let i = idx; i < order.length; i++){
    const key = order[i];
    const p = Number(layerPowers[key] || 0);
    if(baseTotal <= 0) break;
    const potential = floor( baseTotal * (100 + p) / 100 );
    if(potential <= remain[key]){
      remain[key] -= potential;
      totalDug += potential;
      baseTotal = 0;
      break;
    } else {
      const baseNeeded = ceil( remain[key] * 100 / (100 + p) );
      const baseLeft = Math.max(0, baseTotal - baseNeeded);
      totalDug += remain[key];
      remain[key] = 0;
      baseTotal = baseLeft;
      // continue to next layer
    }
  }
  return { dug: totalDug, remainAfter: remain };
}

/* ---------- シミュレート（最大 maxTurns） ---------- */
function simulateTurns(initialRemain, base, supportCounts, layerPowers, maxTurns=8){
  const results = {};
  supportCounts.forEach(n=> results[n] = []);
  supportCounts.forEach(n=>{
    let remain = { sand: initialRemain.sand, ground: initialRemain.ground, rock: initialRemain.rock };
    let done = false;
    for(let t=1; t<=maxTurns; t++){
      if(done){
        results[n].push('完了!!');
        continue;
      }
      const totalBefore = remain.sand + remain.ground + remain.rock;
      if(totalBefore <= 0){
        results[n].push('完了!!');
        done = true;
        continue;
      }
      const one = oneTurnDig(remain, base, n, layerPowers);
      remain = one.remainAfter;
      const totalAfter = remain.sand + remain.ground + remain.rock;
      if(totalAfter <= 0){
        results[n].push('完了!!');
        done = true;
      } else {
        results[n].push(totalAfter);
      }
    }
  });
  return results;
}

/* ---------- 補助: 最短完了ターン数（1..maxTurns, else >max） */
function findCompletionTurn(simResults, maxTurns=8){
  // simResults: { n: [per-turn values or '完了!!'] }
  const summary = {};
  Object.keys(simResults).forEach(k=>{
    const arr = simResults[k];
    let found = null;
    for(let i=0;i<arr.length;i++){
      if(arr[i] === '完了!!'){ found = i+1; break; }
    }
    summary[k] = found ? found : `>${maxTurns}`;
  });
  return summary; // { '0': 3, '1': '>8', ...}
}

/* ---------- メイン描画 ---------- */
function computeAndRender(){
  const resultsDiv = document.getElementById('results');

  // Build equip selects (enabled) — per-layer selectable
  const equipOptionsHtml = DATA.equip.map(r => `<option value="${r.equip_level}" data-adj="${r.equip_adjustment}">Lv${r.equip_level} (+${r.equip_adjustment})</option>`).join('');

  const layers = ['sand','ground','rock'];

  // Build table header
  let html = '<table class="results-table"><thead>';
  html += '<tr>';
  html += '<th rowspan="2">地層</th>';
  html += '<th rowspan="2">装備レベル</th>';
  html += '<th rowspan="2">掘削力（%）</th>';
  html += '<th class="header-parent" colspan="7">掘削量</th>';
  html += '</tr><tr>';
  // practice 0..4
  for(let n=0;n<=4;n++){
    html += `<th>練習 (${n}人)</th>`;
  }
  html += '</tr></thead><tbody>';

  // Determine current selected equip level per layer, if not present use first
  const selectedEquipPerLayer = {};
  layers.forEach(layer=>{
    const sel = document.getElementById(`equip-${layer}`);
    selectedEquipPerLayer[layer] = sel ? sel.value : (DATA.equip.length ? DATA.equip[0].equip_level : 1);
  });

  // But when table not yet rendered, defaults will be first equip level (we'll set selects and attach listeners after)
  // Compute per-layer digging power using currently selected equip values (if exists in DOM) or default to first
  const layerPowers = {};
  layers.forEach(layer=>{
    const sel = document.getElementById(`equip-${layer}`);
    const equipLevel = sel ? sel.value : (DATA.equip.length ? DATA.equip[0].equip_level : 1);
    const equipAdj = getEquipAdjustment(equipLevel);
    const calc = calcDiggingPowerForLayer(layer, equipAdj);
    layerPowers[layer] = calc.total;
  });

  // Render each layer row, with a select (enabled)
  layers.forEach(layer=>{
    const labelJP = LAYER_LABELS_JP[layer];
    // get current selected equip level value if select exists; else use first
    const existingSel = document.getElementById(`equip-${layer}`);
    const equipLevel = existingSel ? existingSel.value : (DATA.equip.length ? DATA.equip[0].equip_level : 1);
    const calc = calcDiggingPowerForLayer(layer, getEquipAdjustment(equipLevel));

    // create select with current selection preserved
    let equipHtml = `<select id="equip-${layer}" class="layer-equip-select">`;
    DATA.equip.forEach(r => {
      const sel = String(r.equip_level) === String(equipLevel) ? 'selected' : '';
      equipHtml += `<option value="${r.equip_level}" ${sel}>Lv${r.equip_level} (+${r.equip_adjustment})</option>`;
    });
    equipHtml += `</select>`;

    html += `<tr>`;
    html += `<td>${labelJP}</td>`;
    html += `<td>${equipHtml}</td>`;
    html += `<td>${calc.total}</td>`;

    // practice 0..4
    for(let n=0;n<=4;n++){
      const v = floor( (BASES.practice + n) * (100 + calc.total) / 100 );
      html += `<td>${v}</td>`;
    }
  });

  html += '</tbody></table>';
  resultsDiv.innerHTML = html;

  // attach change listeners to equip selects to recompute when changed
  layers.forEach(layer=>{
    const sel = document.getElementById(`equip-${layer}`);
    if(!sel) return;
    sel.addEventListener('change', ()=>{ computeAndRender(); computeTurnsSection(); });
  });

  // after table rendered, also render turns section (depends on layerPowers and current remaining)
  computeTurnsSection();
}

/* ---------- 掘削ターン計算と表示 ---------- */
function updateDefaultRemaining(){
  // set initial remaining (current-remaining input) to selected gensen total if empty or equals previous default
  const gsel = document.getElementById('gensen-select');
  const name = gsel.value;
  const found = DATA.gensen.find(r=>r.gensen===name);
  const input = document.getElementById('current-remaining');
  if(!found) return;
  const total = Number(found.sand||0) + Number(found.ground||0) + Number(found.rock||0);
  // If input empty or equals previous gensen total (i.e. not user modified), set; else keep user value
  const prev = input.value;
  if(!prev || prev === '' || Number(prev) === 0){
    input.value = total;
  }
}

function computeTurnsSection(){
  const area = document.getElementById('turns-table-area');
  const summaryDiv = document.getElementById('turns-summary');
  const gsel = document.getElementById('gensen-select');
  const name = gsel.value;
  const found = DATA.gensen.find(r=>r.gensen===name);

  if(!found){
    area.innerHTML = '<div class="gensen-no-check">※源泉を選択すると掘削完了ターン計算が可能になります。</div>';
    summaryDiv.textContent = '';
    return;
  }

  // initial remaining: if user provided a number in textbox use it; otherwise use gensen total
  const userVal = Number(document.getElementById('current-remaining').value);
  let totalInitial = (isNaN(userVal) || userVal <= 0) ? (Number(found.sand||0) + Number(found.ground||0) + Number(found.rock||0)) : userVal;

  // We need per-layer remaining amounts, but user input is a single total. We will distribute the total across layers in the source order:
  // The source provides (sand,ground,rock) values. If user total equals source total, keep per-layer original. If user total < source total,
  // we assume digging has already consumed from earliest layer(s) (sand first), so compute remaining per layer by consuming from sand -> ground -> rock.
  const sourceRemain = { sand: Number(found.sand)||0, ground: Number(found.ground)||0, rock: Number(found.rock)||0 };
  let remainPerLayer = { sand: sourceRemain.sand, ground: sourceRemain.ground, rock: sourceRemain.rock };

  const sourceTotal = sourceRemain.sand + sourceRemain.ground + sourceRemain.rock;
  if(totalInitial >= sourceTotal){
    // user remaining is greater or equal — assume extra in sand (or simply set to total across sand)
    // We'll allocate extra to sand first
    let extra = totalInitial - sourceTotal;
    remainPerLayer = { ...sourceRemain };
    remainPerLayer.sand += extra;
  } else {
    // totalInitial < sourceTotal => assume some digging already happened: consume from sand -> ground -> rock
    let need = sourceTotal - totalInitial; // how much has been dug
    // We remove from sand first
    remainPerLayer = { ...sourceRemain };
    const order = ['sand','ground','rock'];
    for(let k=0;k<order.length && need>0;k++){
      const key = order[k];
      const take = Math.min(need, sourceRemain[key]);
      remainPerLayer[key] = sourceRemain[key] - take;
      need -= take;
    }
    // if need > 0, it means userInitial < 0 or error; but we've handled.
  }

  // Collect per-layer digging powers — note: use currently selected equip levels for each layer
  const layerPowers = {};
  ['sand','ground','rock'].forEach(layer=>{
    const sel = document.getElementById(`equip-${layer}`);
    const equipLevel = sel ? sel.value : (DATA.equip.length ? DATA.equip[0].equip_level : 1);
    const equipAdj = getEquipAdjustment(equipLevel);
    const calc = calcDiggingPowerForLayer(layer, equipAdj);
    layerPowers[layer] = calc.total;
  });

  // simulate for support counts 0..4
  const supportCounts = [0,1,2,3,4];
  const sim = simulateTurns(remainPerLayer, BASES.practice, supportCounts, layerPowers, 8);

  // Build turns table (rows: 1..8, columns: per support count)
  let table = '<table class="turns-table"><thead><tr><th>ターン</th>';
  supportCounts.forEach(n=> table += `<th>練習 (${n}人)</th>`);
  table += '</tr></thead><tbody>';
  for(let t=0;t<8;t++){
    table += `<tr><td>${t+1}ターン目</td>`;
    supportCounts.forEach(n=>{
      const cell = sim[n][t];
      table += `<td>${cell === undefined ? '-' : cell}</td>`;
    });
    table += '</tr>';
  }
  table += '</tbody></table>';
  area.innerHTML = table;

  // Compute summary: shortest completion turn for each support count
  const summary = findCompletionTurn(sim, 8);
  // Build summary text like "完了ターン: 練習(0人)=3 / 練習(1人)=2 / ... "
  const parts = [];
  supportCounts.forEach(n=>{
    parts.push(`練習(${n}人): ${summary[n]}`);
  });
  summaryDiv.textContent = `完了ターン（最大8ターン表示） — ${parts.join(' / ')}`;
}

/* ---------- メモ保存 ---------- */
const MEMO_KEY = 'yukoma_tool_user_memo';
function saveMemo(){
  const v = document.getElementById('user-memo').value || '';
  try{ localStorage.setItem(MEMO_KEY, v); }catch(e){}
}
function loadMemo(){
  try{
    const v = localStorage.getItem(MEMO_KEY) || '';
    document.getElementById('user-memo').value = v;
  }catch(e){}
}

/* ---------- 起動 ---------- */
init();