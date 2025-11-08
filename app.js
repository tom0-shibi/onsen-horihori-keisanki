// app.js
// 指定の計算式に基づいて掘削力・掘削量を算出する静的 JS。
// 掘削量 = FLOOR( 基礎値 + サポカ人数 × (100 + 掘削力) / 100 )

/* ---------- ユーティリティ ---------- */
async function fetchText(path){
  const res = await fetch(path);
  if(!res.ok) throw new Error('Failed to load ' + path);
  return await res.text();
}

function parseCSV(text){
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h=>h.trim());
  return lines.slice(1).map(line=>{
    const cols = line.split(',').map(c=>c.trim());
    const obj = {};
    headers.forEach((h,i)=> obj[h]=cols[i]===undefined? '': cols[i]);
    return obj;
  });
}

function floor(v){ return Math.floor(v); }

/* ---------- グローバルデータ ---------- */
const DATA = {
  gensen: [],
  rank: [],
  factor: [],
  equip: []
};

/* ---------- 初期化 ---------- */
async function init(){
  try {
    DATA.gensen = parseCSV(await fetchText('data/gensen.csv'));
    DATA.rank = parseCSV(await fetchText('data/rank.csv'));
    DATA.factor = parseCSV(await fetchText('data/factor.csv'));
    DATA.equip = parseCSV(await fetchText('data/equip.csv'));
  } catch(e){
    alert('データ読み込みに失敗しました: ' + e.message);
    console.error(e);
    return;
  }

  buildUI();
  attachListeners();
  computeAndRender();
}

/* ---------- UI 構築 ---------- */
const RANK_ORDER = ['G','F','E','D','C','B','A','S','SS','UG'];

function buildUI(){
  // rank selects
  document.querySelectorAll('.rank-select').forEach(s=>{
    RANK_ORDER.forEach(r=>{
      const opt = document.createElement('option');
      opt.value = r; opt.textContent = r;
      s.appendChild(opt);
    });
    s.value = 'G';
  });

  // factor selects (0..10 など)
  document.querySelectorAll('.factor-select').forEach((s)=>{
    for(let i=0;i<=10;i++){
      const opt = document.createElement('option');
      opt.value = i; opt.textContent = i;
      s.appendChild(opt);
    }
    s.value = 0;
  });

  // equip levels from CSV
  const equipSel = document.getElementById('equip-level');
  DATA.equip.forEach(row => {
    const opt = document.createElement('option');
    opt.value = row.equip_level;
    opt.textContent = `Lv${row.equip_level} (+${row.equip_adjustment})`;
    equipSel.appendChild(opt);
  });
  equipSel.value = DATA.equip[0].equip_level;

  // gensen select
  const gsel = document.getElementById('gensen-select');
  DATA.gensen.forEach(row=>{
    const opt = document.createElement('option');
    opt.value = row.gensen;
    opt.textContent = row.gensen;
    gsel.appendChild(opt);
  });
}

/* ---------- イベント ---------- */
function attachListeners(){
  document.querySelectorAll('select, input[type="checkbox"]').forEach(el=>{
    el.addEventListener('change', computeAndRender);
  });

  document.getElementById('gensen-select').addEventListener('change', showGensenInfo);
  showGensenInfo();
}

/* ---------- 表示用: 源泉情報 ---------- */
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
    nameEl.textContent = '';
    sandEl.textContent = '-'; groundEl.textContent='-'; rockEl.textContent='-'; totalEl.textContent='-';
    imgBox.innerHTML = '画像';
    return;
  }
  nameEl.textContent = found.gensen;
  const sand = Number(found.sand)||0;
  const ground = Number(found.ground)||0;
  const rock = Number(found.rock)||0;
  sandEl.textContent = sand;
  groundEl.textContent = ground;
  rockEl.textContent = rock;
  totalEl.textContent = (sand+ground+rock);

  const slug = slugify(found.gensen);
  const imgPath = `images/${slug}.png`;
  imgBox.innerHTML = '';
  const img = document.createElement('img');
  img.src = imgPath;
  img.alt = found.gensen;
  img.onload = ()=>{};
  img.onerror = ()=>{ imgBox.textContent = '画像なし'; };
  imgBox.appendChild(img);
}

/* ---------- slug化ユーティリティ ---------- */
function slugify(s){
  return s.toLowerCase().replace(/[^\w\u3040-\u30ff\u4e00-\u9fff]+/g,'-').replace(/^-+|-+$/g,'');
}

/* ---------- 計算ロジック ---------- */

const STAT_KEYS = ['speed','stamina','power','guts','wit'];
// 地層ごとのstat->(high/middle/low) マッピング（仕様に基づく）
const RANK_MAP = {
  speed: { sand:'high', ground:'middle' },
  stamina: { sand:'low', rock:'low' },
  power: { ground:'low', rock:'high' },
  guts: { ground:'high' },
  wit: { sand:'middle', rock:'middle' }
};

// シナリオリンクが加算される地層
const LINK_TO_LAYER = {
  teio: 'sand',
  bourbon: 'ground',
  tran: 'ground',
  tarmae: 'rock',
  acute: 'rock'
};

// 基礎値
const BASES = { practice:25, rest:15, pr:10 };

// CSV の検索ユーティリティ
function getRankRow(rank){
  return DATA.rank.find(r=>r.rank===rank);
}
function getEquipAdjustment(level){
  const row = DATA.equip.find(r=> Number(r.equip_level) === Number(level));
  return row ? Number(row.equip_adjustment) : 0;
}
function getFactorRow(statKey){
  return DATA.factor.find(r=> r.status === statKey);
}

/* 実際の掘削力計算（地層ごと） */
function calcDiggingPowerForLayer(layer){
  // 1) 基礎能力（各ステータスのランク→high/middle/low を見て bonus_* を参照。対象外なら0）
  let baseBonusSum = 0;
  STAT_KEYS.forEach(statKey=>{
    const selectId = {
      speed:'rank-speed', stamina:'rank-stamina', power:'rank-power', guts:'rank-guts', wit:'rank-wit'
    }[statKey];
    const rank = document.getElementById(selectId).value;
    const mapping = RANK_MAP[statKey];
    const tier = mapping && mapping[layer] ? mapping[layer] : null;
    if(!tier){ return; } // 対象外 => 0
    const rankRow = getRankRow(rank);
    if(!rankRow) return;
    const colName = {
      high:'bonus_high', middle:'bonus_middle', low:'bonus_low'
    }[tier];
    baseBonusSum += Number(rankRow[colName]||0);
  });

  // 2) 因子: 各因子個数 * factor.csv の layer 列
  let factorSum = 0;
  STAT_KEYS.forEach(statKey=>{
    const selectId = {
      speed:'factor-speed', stamina:'factor-stamina', power:'factor-power', guts:'factor-guts', wit:'factor-wit'
    }[statKey];
    const cnt = Number(document.getElementById(selectId).value) || 0;
    if(cnt <= 0) return;
    const factorRow = getFactorRow(statKey);
    if(!factorRow) return;
    const per = Number(factorRow[layer]||0);
    factorSum += per * cnt;
  });

  // 3) シナリオリンク: チェックされている分だけ +10 を layer に加算
  let linkBonus = 0;
  const linkChecks = [
    ['link-teio','teio'],
    ['link-bourbon','bourbon'],
    ['link-tran','tran'],
    ['link-tarmae','tarmae'],
    ['link-acute','acute']
  ];
  linkChecks.forEach(([elId, key])=>{
    const el = document.getElementById(elId);
    if(el && el.checked && LINK_TO_LAYER[key] === layer) linkBonus += 10;
  });

  // 4) 装備レベル
  const equipLv = Number(document.getElementById('equip-level').value || 1);
  const equipAdj = getEquipAdjustment(equipLv);

  return {
    baseBonusSum,
    factorSum,
    linkBonus,
    equipAdj,
    total: baseBonusSum + factorSum + linkBonus + equipAdj
  };
}

/* レンダリング（結果テーブル） */
function computeAndRender(){
  const layers = ['sand','ground','rock'];
  const resultsDiv = document.getElementById('results');
  let html = '<table><thead><tr><th>地層</th><th>装備Lv</th><th>掘削力（%）</th><th>内訳（基礎/因子/リンク/装備）</th>';
  // サポカ人数の表示は 1 〜 4 人
  const supportCounts = [1,2,3,4];
  const activities = [
    {key:'practice', label:'練習', base:BASES.practice},
    {key:'rest', label:'お休み', base:BASES.rest},
    {key:'pr', label:'PR', base:BASES.pr}
  ];
  // 各サポカ人数ごとに activity 列を作る（例: 練習(1人), お休み(1人), PR(1人), 練習(2人) ...）
  supportCounts.forEach(n=>{
    activities.forEach(act=>{
      html += `<th>${act.label} (${n}人)</th>`;
    });
  });
  html += '</tr></thead><tbody>';

  layers.forEach(layer=>{
    const calc = calcDiggingPowerForLayer(layer);
    const equipLv = Number(document.getElementById('equip-level').value || 1);
    html += `<tr>`;
    html += `<td>${layer}</td>`;
    html += `<td>Lv${equipLv}</td>`;
    html += `<td>${calc.total}</td>`;
    html += `<td>${calc.baseBonusSum} / ${calc.factorSum} / ${calc.linkBonus} / ${calc.equipAdj}</td>`;

    supportCounts.forEach(n=>{
      activities.forEach(act=>{
        // サポカ人数の式: FLOOR( 基礎値 + サポカ人数 × (100 + 掘削力) / 100 )
        const val = floor( act.base + n * (100 + calc.total) / 100 );
        html += `<td>${val}</td>`;
      });
    });

    html += `</tr>`;
  });

  html += '</tbody></table>';
  resultsDiv.innerHTML = html;
}

/* ---------- 起動 ---------- */
init();