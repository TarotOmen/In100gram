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

function doGet() {
  const rows = getRows_();
  return ContentService.createTextOutput(JSON.stringify(rows)).setMimeType(ContentService.MimeType.JSON);
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
  ROOT_FOLDER_GROUPS.forEach(group => {
    const folders = DriveApp.getFoldersByName(group.name);
    while (folders.hasNext()) {
      const folder = folders.next();
      scanFolder_(folder, group, rows, seen);
    }
  });
  if (rows.length) sheet.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, HEADERS.length);
  return `Added ${rows.length} image rows to ${SHEET_NAME}.`;
}

function scanFolder_(folder, group, rows, seen) {
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName();
    if (!/\.(png|jpe?g|webp|gif)$/i.test(name)) continue;
    const id = file.getId();
    if (seen[id]) continue;
    const meta = inferMeta_(name, folder.getName(), group);
    if (!meta) continue;
    // Images must be reachable by a browser inside the Mini App. This changes sharing on image files only.
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { console.warn('Could not change sharing for ' + name + ': ' + e); }
    const directUrl = 'https://drive.google.com/uc?export=view&id=' + encodeURIComponent(id);
    const imageId = name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
    rows.push([imageId, meta.category, meta.actionId || '', meta.gender || 'both', meta.level || '', id, directUrl, true]);
    seen[id] = true;
  }
  const children = folder.getFolders();
  while (children.hasNext()) scanFolder_(children.next(), group, rows, seen);
}

function inferMeta_(fileName, folderName, group) {
  const text = (folderName + ' ' + fileName).toLowerCase();
  if (group.category === 'action') {
    const m = text.match(/(?:action[_-])?(100g|50g|25g|cocktail|beer|glass|bottle)/i);
    if (!m) return null;
    return { category: 'action', actionId: m[1].toLowerCase(), gender: 'both', level: '' };
  }
  if (group.category === 'badge' || group.category === 'reward') {
    const levelMatch = text.match(/(?:level|lvl|уров(?:ень)?|badge|reward|_)(?:[_ -]*)?(\d{1,2})/i) || fileName.match(/(?:^|[_ -])(\d{1,2})(?:[_ .-]|$)/);
    if (!levelMatch) return null;
    const level = Number(levelMatch[1]);
    if (level < 1 || level > 16) return null;
    return { category: group.category, gender: group.gender, level: level };
  }
  if (group.category === 'ui') return { category: 'ui', gender: 'both', level: '' };
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
