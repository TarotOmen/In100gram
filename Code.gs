/** In100gram image registry. Deploy this Apps Script as a Web App after pasting it into Code.gs.
 * Uses the existing spreadsheet and searches the known image folders in your Google Drive.
 */
const SPREADSHEET_ID = '102cUyWa_Bm9ejNJ2mLuxq4NkBDBAVRYJat3sqON5Go4';
const SHEET_NAME = 'Images';
const ROOT_FOLDER_GROUPS = [
  { name: '02_ACTIONS', category: 'action' },
  { name: '03_BADGES_MALE', category: 'badge', gender: 'male' },
  { name: '04_BADGES_FEMALE', category: 'badge', gender: 'female' },
  { name: '05_REWARDS_MALE', category: 'reward', gender: 'male' },
  { name: '06_REWARDS_FEMALE', category: 'reward', gender: 'female' },
  { name: '01_UI', category: 'ui', gender: 'both' }
];
const HEADERS = ['image_id','category','action_id','gender','level','file_id','url','active'];

function doGet(e) {
  // The normal endpoint stays a JSON array for Render. Add ?report=1 for a diagnostic report.
  const rows = getRows_();
  const report = e && e.parameter && e.parameter.report === '1';
  const output = report ? buildRegistryReport_(rows) : rows;
  return ContentService.createTextOutput(JSON.stringify(output)).setMimeType(ContentService.MimeType.JSON);
}

function buildRegistryReport_(rows) {
  const report = { total: rows.length, actions: {}, badges: { male: {}, female: {} }, rewards: { male: {}, female: {} }, missing: [], urlExamples: rows.slice(0, 5).map(r => ({ image_id: r.image_id, file_id: r.file_id, url: r.url, active: r.active })) };
  ['100g','50g','25g','cocktail','beer','glass','bottle'].forEach(id => report.actions[id] = rows.filter(r => r.category === 'action' && r.action_id === id).length);
  ['male','female'].forEach(gender => {
    ['badge','reward'].forEach(category => {
      for (let level = 1; level <= 16; level++) {
        const count = rows.filter(r => r.category === category && r.gender === gender && Number(r.level) === level).length;
        report[category === 'badge' ? 'badges' : 'rewards'][gender][level] = count;
        if (!count) report.missing.push(`${category}:${gender}:${level}`);
      }
    });
  });
  return report;
}

// Run once manually from Apps Script editor to populate the Images sheet from Drive.
function syncRegistry() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  const rows = [];
  const seen = {};
  const skipped = [];
  const scanStats = { scanned: 0, shared: 0, skipped: 0 };
  ROOT_FOLDER_GROUPS.forEach(group => {
    const folders = DriveApp.getFoldersByName(group.name);
    while (folders.hasNext()) {
      const folder = folders.next();
      scanFolder_(folder, group, rows, seen, skipped, scanStats);
    }
  });
  if (rows.length) sheet.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, HEADERS.length);
  const summary = { added: rows.length, scanned: scanStats.scanned, shared: scanStats.shared, skipped: scanStats.skipped, skippedFiles: skipped.slice(0, 50) };
  console.log(JSON.stringify(summary));
  return JSON.stringify(summary);
}

function scanFolder_(folder, group, rows, seen, skipped, scanStats) {
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();
    if (!/\.(png|jpe?g|webp|gif)$/i.test(name)) continue;
    scanStats.scanned++;
    const id = file.getId();
    if (seen[id]) continue;
    const meta = inferMeta_(name, folder.getName(), group);
    if (!meta) continue;
    // Images must be publicly viewable. Do not register an image as active if Drive sharing fails.
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      const access = file.getSharingAccess();
      if (access !== DriveApp.Access.ANYONE_WITH_LINK && access !== DriveApp.Access.ANYONE) {
        throw new Error('Sharing access is still restricted: ' + access);
      }
      scanStats.shared++;
    } catch (e) {
      scanStats.skipped++;
      skipped.push({ name: name, file_id: id, reason: String(e && e.message ? e.message : e) });
      console.warn('Skipping inaccessible image ' + name + ': ' + e);
      continue;
    }
    // Thumbnail endpoint is more reliable for inline display than the old uc?export=view URL.
    const directUrl = 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(id) + '&sz=w1600';
    const imageId = name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
    rows.push([imageId, meta.category, meta.actionId || '', meta.gender || 'both', meta.level || '', id, directUrl, true]);
    seen[id] = true;
  }
  const children = folder.getFolders();
  while (children.hasNext()) scanFolder_(children.next(), group, rows, seen, skipped, scanStats);
}

function inferMeta_(fileName, folderName, group) {
  // IMPORTANT: infer level from the FILE NAME only. Folder names start with 03/04/05/06
  // and must never be mistaken for level numbers.
  const fileBase = String(fileName).replace(/\.[^.]+$/, '').toLowerCase().replace(/[ё]/g, 'е');
  if (group.category === 'action') {
    const m = fileBase.match(/(?:action[_ -]*)?(100g|50g|25g|cocktail|beer|glass|bottle)/i);
    if (!m) return null;
    return { category: 'action', actionId: m[1].toLowerCase(), gender: 'both', level: '' };
  }
  if (group.category === 'badge' || group.category === 'reward') {
    const level = inferLevelFromName_(fileBase);
    if (!level) return null;
    return { category: group.category, gender: group.gender, level: level };
  }
  if (group.category === 'ui') return { category: 'ui', gender: 'both', level: '' };
  return null;
}

function inferLevelFromName_(fileBase) {
  const text = String(fileBase).toLowerCase().replace(/[ё]/g, 'е');
  // Recognize agreed numbered filenames such as badge_male_01, badge_female_16,
  // reward_male_05, level_12, and level12. Ignore digits in gender or folder names.
  const patterns = [
    /(?:^|[_ -])(?:badge|reward)[_ -]*(?:male|female)[_ -]*(1[0-6]|0?[1-9])(?:$|[_ -])/i,
    /(?:^|[_ -])(?:badge|reward)[_ -]*(1[0-6]|0?[1-9])(?:$|[_ -])/i,
    /(?:^|[_ -])(?:level|lvl|уров(?:ень)?)[_ -]*(1[0-6]|0?[1-9])(?:$|[_ -])/i,
    /(?:^|[_ -])(1[0-6]|0?[1-9])(?:$|[_ -])/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) { const n = Number(m[1]); if (n >= 1 && n <= 16) return n; }
  }
  const groups = [
    ['novichok','новичок','newbie'], ['stazher','стажер','intern'],
    ['svoi_chelovek','свой человек','своя в доску','own person'], ['profi','профи','professional'],
    ['avtoritet','авторитет','authority'], ['tsenitel','ценитель','connoisseur'], ['maestro','маэстро'],
    ['elitny_igrok','элитный игрок','elite player'], ['legenda','легенда','legend'], ['magnat','магнат','magnate'],
    ['korol','король','королева','king','queen'], ['titan','титан'], ['vysshaya_elita','высшая элита'],
    ['boss','босс'], ['imperator','император','императрица','emperor','empress'],
    ['vlastelin_galaktiki','властелин галактики','властительница галактики','galaxy']
  ];
  const normalized = text.replace(/[_-]+/g, ' ');
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].some(word => normalized.includes(word.toLowerCase().replace(/[_-]+/g, ' ')))) return i + 1;
  }
  return null;
}

function getRows_() {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(1, 1, sheet.getLastRow(), HEADERS.length).getValues();
  const header = values.shift().map(String);
  const index = {}; header.forEach((h, i) => index[h] = i);
  return values.filter(r => r[index.image_id] && r[index.url] && String(r[index.active]).toLowerCase() !== 'false')
    .map(r => ({ image_id: String(r[index.image_id]), category: String(r[index.category] || ''), action_id: String(r[index.action_id] || ''), gender: String(r[index.gender] || 'both'), level: r[index.level] === '' ? null : Number(r[index.level]), file_id: String(r[index.file_id] || ''), url: String(r[index.url]), active: true }));
}
