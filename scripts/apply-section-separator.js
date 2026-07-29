const fs = require('fs');
const path = require('path');
const { SECTION_INSTR, TOOLS } = require('./section-separator-migrate');

const BACKEND = path.join(__dirname, '..', 'api', 'ai-tools-public.js');
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'creatorversed-standalone-tools');

function patchBackend() {
  let src = fs.readFileSync(BACKEND, 'utf8');
  const keys = [...new Set(TOOLS.map((t) => t.backendKey))];
  let n = 0;
  for (const key of keys) {
    const marker = `'${key}':`;
    const start = src.indexOf(marker);
    if (start === -1) {
      console.warn('MISS backend key', key);
      continue;
    }
    const sysIdx = src.indexOf('system: `', start);
    const toneIdx = src.indexOf('${TONE_INSTRUCTIONS}`', sysIdx);
    if (sysIdx === -1 || toneIdx === -1) {
      console.warn('MISS system block', key);
      continue;
    }
    const body = src.slice(sysIdx + 'system: `'.length, toneIdx);
    if (body.includes('===SECTION===')) continue;
    const insert = body.trimEnd() + '\n\n' + SECTION_INSTR + '\n\n';
    src = src.slice(0, sysIdx + 'system: `'.length) + insert + src.slice(toneIdx);
    n++;
  }
  fs.writeFileSync(BACKEND, src);
  console.log('backend tools updated:', n);
}

function patchFrontendFile(htmlPath) {
  let src = fs.readFileSync(htmlPath, 'utf8');
  const orig = src;

  src = src.replace(/var SECT\s*=\s*'---SECTION---'/g, "var SECT = '===SECTION==='");
  src = src.replace(/var SECT='---SECTION---'/g, "var SECT='===SECTION==='");

  // Generic buildContext separator wording
  src = src.replace(/Separate analysis sections with exactly '\+SECT\+' then a section title, then the body/g,
    "Separate analysis sections with a line containing only '+SECT+'. After each marker, put the section title on its own line, then the content");
  src = src.replace(/Separate sections with exactly '\+SECT\+' then a section title and body/g,
    "Separate sections with a line containing only '+SECT+'. After each marker, put the section title on its own line, then the content");
  src = src.replace(/Separate major sections with exactly '\+SECT\+' then a section title on the next line, then the section body/g,
    "Separate major sections with a line containing only '+SECT+'. After each marker, put the section title on its own line, then the section content");
  src = src.replace(/Separate sections with ---SECTION--- then title and body when helpful/g,
    'Separate sections with a line containing only ===SECTION===. After each marker, put the section title on its own line, then the content');

  // Named-token tools -> ===SECTION===
  const namedReplacements = [
    [/var METRIC='---METRIC---', AUTH='---AUTHORITY---', VALUE='---VALUE---', CREATIVE='---CREATIVE---', TIPS='---TIPS---';/g,
      "var SECT = '===SECTION===';"],
    [/var SHORT='---SHORT---', DETAILED='---DETAILED---', DM='---DM---';/g, "var SECT = '===SECTION===';"],
    [/var SEP = '---VALUE_VERSION---';/g, "var SECT = '===SECTION===';"],
    [/var SEP = '---FULL_VERSION---';/g, "var SECT = '===SECTION===';"],
    [/var IDEA_SEP='---IDEA---';/g, "var SECT = '===SECTION===';"],
    [/var TAGLINE_SEP = '---TAGLINE---';\s*\n\s*var NOTE_SEP = '---TESTING_NOTE---';/g, "var SECT = '===SECTION===';"],
    [/var SEP_SHORT = '---CAPTION_SHORT---', SEP_MED = '---CAPTION_MEDIUM---', SEP_LONG = '---CAPTION_LONG---', SEP_NOTE = '---PLATFORM_NOTE---';/g,
      "var SECT = '===SECTION===';"],
    [/var SEP_SCORE = '---SCORE---', SEP_ANALYSIS = '---ANALYSIS---', SEP_ALT = '---ALT---';/g, "var SECT = '===SECTION===';"],
    [/var SCORE='---SCORE---', ANALYSIS='---ANALYSIS---', SEO='---SEO---', CTR='---CTR---', HYBRID='---HYBRID---', TIPS='---TIPS---';/g,
      "var SECT = '===SECTION===';"],
    [/var HOOK='---HOOK---', SCENE='---SCENE---', CAPTION='---CAPTION---';/g, "var SECT = '===SECTION===';"],
    [/var SECT='---SECTION---', DECODED='---DECODED---';/g, "var SECT='===SECTION===';"],
  ];
  for (const [re, rep] of namedReplacements) src = src.replace(re, rep);

  // meeting-notes: ensure SECT defined
  if (htmlPath.includes('meeting-notes-generator') && !/var SECT\s*=/.test(src)) {
    src = src.replace(
      /function escapeHtml\(s\)\{ var d=document\.createElement\('div'\); d\.textContent=s; return d\.innerHTML; \}/,
      "function escapeHtml(s){ var d=document.createElement('div'); d.textContent=s; return d.innerHTML; }\n      var SECT = '===SECTION===';"
    );
  }

  // brand-voice broken duplicate stripSignOff fragment
  src = src.replace(/\nvar SECT='===SECTION===';\n\n\s+return keep\.join\('\\n'\)\.replace\(\/\\n\{3,\}\/g,'\\n\\n'\)\.trim\(\);\n\s+\}/g,
    "\nvar SECT='===SECTION===';");

  if (src !== orig) fs.writeFileSync(htmlPath, src);
  return src !== orig;
}

function main() {
  patchBackend();
  let n = 0;
  for (const tool of TOOLS) {
    const p = path.join(FRONTEND_DIR, tool.html);
    if (!fs.existsSync(p)) {
      console.warn('missing', tool.html);
      continue;
    }
    if (patchFrontendFile(p)) {
      n++;
      console.log('patched frontend', tool.html);
    }
  }
  console.log('frontend files patched:', n);
}

if (require.main === module) main();

module.exports = { patchBackend, patchFrontendFile };
