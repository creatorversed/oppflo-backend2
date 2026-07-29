const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', 'creatorversed-standalone-tools');
const SECT_INSTR =
  "Separate each section with a line containing only '+SECT+'. After each marker, put the section title on its own line, then the content. Do not use --- dividers.";

const HELPER = `
      function parseSectionBlocks(raw){
        var text=(raw||'').replace(/\\*\\*(.+?)\\*\\*/g,'$1').replace(/\\*(.+?)\\*/g,'$1').trim();
        if(!text) return [];
        if(text.indexOf('===SECTION===')===-1) return [{title:'Section',body:text}];
        return text.split(/\\n?\\s*===SECTION===\\s*\\n?/).map(function(p){return p.trim();}).filter(Boolean).map(function(chunk){
          var nl=chunk.indexOf('\\n');
          if(nl===-1) return {title:chunk,body:''};
          return {title:chunk.slice(0,nl).trim(),body:chunk.slice(nl+1).trim()};
        });
      }`;

function patch(file, fn) {
  const p = path.join(FRONTEND, file);
  let src = fs.readFileSync(p, 'utf8');
  const next = fn(src);
  if (next !== src) fs.writeFileSync(p, next);
  return next !== src;
}

function ensureHelper(src) {
  if (src.includes('function parseSectionBlocks(')) return src;
  return src.replace(
    /var SECT = '===SECTION===';/,
    "var SECT = '===SECTION===';" + HELPER
  );
}

const patches = {
  'resume-headline-generator.html'(src) {
    src = ensureHelper(src);
    src = src.replace(
      /function buildHeadlineContext\(\)\{\s*return \[\s*'Generate FOUR categories[\s\S]*?\]\.join\('\\n'\);\s*\}/,
      `function buildHeadlineContext(){
        return [
          'Generate FOUR categories of resume headlines plus a tips section. ${SECT_INSTR} Use section titles: Metric-Led Headlines, Authority-Led Headlines, Value-Led Headlines, Creative Headlines, Tips. Plain text only, no markdown.',
          'Title: '+document.getElementById('title').value.trim(),
          'Years of experience: '+document.getElementById('years').value,
          'Industry: '+document.getElementById('industry').value,
          'Biggest achievement: '+document.getElementById('achievement').value.trim(),
          'Key differentiator: '+document.getElementById('differentiator').value.trim(),
          'Target audience: '+document.getElementById('target_audience').value,
          'Headline purpose: '+document.getElementById('purpose').value,
          'Tone: '+document.getElementById('tone').value
        ].join('\\n');
      }`
    );
    src = src.replace(/function parseHeadlines[\s\S]*?return \{ metric: metric[\s\S]*?\};\s*\}/,
      `function parseHeadlines(raw){
        var blocks=parseSectionBlocks(raw);
        var out={metric:[],authority:[],value:[],creative:[],tips:''};
        blocks.forEach(function(b){
          var t=(b.title||'').toLowerCase();
          var lines=splitLines(b.body||'');
          if(t.indexOf('metric')!==-1) out.metric=lines;
          else if(t.indexOf('authority')!==-1) out.authority=lines;
          else if(t.indexOf('value')!==-1) out.value=lines;
          else if(t.indexOf('creative')!==-1) out.creative=lines;
          else if(t.indexOf('tip')!==-1) out.tips=(b.body||'').trim();
        });
        if(out.metric.length+out.authority.length+out.value.length+out.creative.length===0){
          var all=splitLines(raw);
          var n=all.length;
          if(n>=10){ out.metric=all.slice(0,3); out.authority=all.slice(3,6); out.value=all.slice(6,8); out.creative=all.slice(8,10); }
        }
        return out;
      }`);
    return src;
  },

  'brand-pitch-generator.html'(src) {
    src = ensureHelper(src);
    src = src.replace(
      /function buildPitchContext\(\)[\s\S]*?\]\.join\('\\n'\);\s*\}/,
      `function buildPitchContext(){
        return [
          "GENERATE A BRAND PITCH EMAIL (cold outreach to a brand for partnership): Generate THREE variations. ${SECT_INSTR} Section titles: Short cold email, Detailed pitch email, DM version. Include Subject: on the first line of email sections.",
          'Your name: '+document.getElementById('your_name').value.trim(),
          'Platform/handle: '+document.getElementById('platform_handle').value.trim(),
          'Niche: '+document.getElementById('niche').value,
          'Audience size and engagement: '+document.getElementById('audience_engagement').value.trim(),
          'Brand: '+document.getElementById('brand').value.trim(),
          'Contact person: '+document.getElementById('contact_person').value.trim(),
          'Why this brand: '+document.getElementById('why_brand').value.trim(),
          'Pitch angle: '+document.getElementById('pitch_angle').value.trim(),
          'Best result for a brand: '+document.getElementById('best_result').value.trim(),
          'Pitch style: '+document.getElementById('pitch_style').value
        ].join('\\n');
      }`
    );
    src = src.replace(/function parsePitches[\s\S]*?return \[\s*\{ label:[\s\S]*?\};\s*\}/,
      `function parsePitches(raw){
        var blocks=parseSectionBlocks(raw);
        var labels=['Short cold email (under 150 words)','Detailed pitch email','DM version (Instagram/LinkedIn)'];
        if(!blocks.length) return [{label:labels[0],text:(raw||'').trim()}];
        return blocks.slice(0,3).map(function(b,i){ return {label:labels[i]||b.title,text:(b.body||b.title||'').trim()}; });
      }`);
    return src;
  },

  'value-proposition-generator.html'(src) {
    src = ensureHelper(src);
    src = src.replace(
      /'Generate FOUR value proposition versions for different use cases\. Separate each with exactly '\+SEP\+'\. Plain text only\.'/,
      `'Generate FOUR value proposition versions for different use cases. ${SECT_INSTR} Use titles: One-liner, Short, Full paragraph, Use-case version. Plain text only.'`
    );
    src = src.replace(/function parseFour[\s\S]*?return parts\.slice\(0,4\)[\s\S]*?\}/,
      `function parseFour(text){
        var blocks=parseSectionBlocks(text);
        var out=blocks.map(function(b){ return (b.body||b.title||'').trim(); });
        while(out.length<4) out.push('');
        return out.slice(0,4);
      }`);
    return src;
  },

  'origin-story-creator.html'(src) {
    src = ensureHelper(src);
    src = src.replace(/var SEP = '===SECTION===';/, "var SECT = '===SECTION===';" + HELPER);
    src = src.replace(/Separate them with exactly: '\+SEP\+'/g, SECT_INSTR);
    src = src.replace(/function parseStories[\s\S]*?return \{ short:[\s\S]*?\};\s*\}/,
      `function parseStories(raw){
        var blocks=parseSectionBlocks(raw);
        var short='', full='';
        blocks.forEach(function(b){
          var t=(b.title||'').toLowerCase();
          if(t.indexOf('short')!==-1) short=(b.body||'').trim();
          else if(t.indexOf('full')!==-1) full=(b.body||'').trim();
        });
        if(!short&&!full){ short=(raw||'').trim(); }
        return {short:short,full:full};
      }`);
    return src;
  },

  'tiktok-video-idea-generator.html'(src) {
    src = ensureHelper(src);
    src = src.replace(
      /return \['Generate TikTok video ideas\. For each idea use exactly: '\+IDEA_SEP\+'[\s\S]*?'\];/,
      `return ['Generate TikTok video ideas. ${SECT_INSTR} Use section titles like Idea 1, Idea 2, etc. Each section: working title, opening hook (first 2 sec), concept description, format/style, virality potential, audio strategy guidance.',
          'Niche: '+document.getElementById('niche').value,
          'Content style: '+document.getElementById('content_style').value,
          'Audience: '+document.getElementById('audience').value,
          'Goal: '+document.getElementById('goal').value,
          'Number of ideas: '+document.getElementById('num_ideas').value
        ];`
    );
    src = src.replace(/if\(raw\.indexOf\(IDEA_SEP\)!==-1\)[\s\S]*?return \[raw\.trim\(\)\];/,
      `var blocks=parseSectionBlocks(raw);
        if(blocks.length) return blocks.map(function(b){ return ((b.title?b.title+'\\n':'')+(b.body||'')).trim(); }).filter(Boolean);
        return [raw.trim()];`);
    return src;
  },

  'tagline-generator.html'(src) {
    src = ensureHelper(src);
    src = src.replace(
      /'Generate multiple tagline options\. Separate each tagline with exactly '\+TAGLINE_SEP\+'\. End with '\+NOTE_SEP\+' and a brief note on how to test taglines\. Plain text only\.'/,
      `'Generate multiple tagline options. ${SECT_INSTR} Use one section per tagline (Tagline 1, Tagline 2, etc.) and a final section titled Testing note. Plain text only.'`
    );
    src = src.replace(/if\(raw\.indexOf\(NOTE_SEP\)!==-1\)[\s\S]*?var parts = raw\.split\(TAGLINE_SEP\)[\s\S]*?return \{ taglines: parts, note: note \};/,
      `var blocks=parseSectionBlocks(raw);
        var taglines=[], note='';
        blocks.forEach(function(b){
          if((b.title||'').toLowerCase().indexOf('test')!==-1) note=(b.body||'').trim();
          else { var line=(b.body||b.title||'').trim(); if(line) taglines.push(line); }
        });
        return { taglines: taglines, note: note };`);
    return src;
  },

  'caption-writer-pro.html'(src) {
    src = ensureHelper(src);
    src = src.replace(
      /'Generate THREE caption variations\. Separate with exactly: '\+SEP_SHORT\+'[\s\S]*?2026\.'/,
      `'Generate THREE caption variations. ${SECT_INSTR} Section titles: Short caption, Medium caption, Long caption, Platform note. Under each caption include platform-specific hashtag suggestions.'`
    );
    src = src.replace(/function parseCaptions[\s\S]*?return \{ short: short[\s\S]*?\};\s*\}/,
      `function parseCaptions(raw){
        var blocks=parseSectionBlocks(raw);
        var out={short:'',medium:'',long_:'',note:''};
        blocks.forEach(function(b){
          var t=(b.title||'').toLowerCase();
          var body=(b.body||'').trim();
          if(t.indexOf('short')!==-1) out.short=body;
          else if(t.indexOf('medium')!==-1) out.medium=body;
          else if(t.indexOf('long')!==-1) out.long_=body;
          else if(t.indexOf('platform')!==-1||t.indexOf('note')!==-1) out.note=body;
        });
        if(!out.short&&!out.medium&&!out.long_) out.short=(raw||'').trim();
        return {short:out.short,medium:out.medium,long_:out.long_,note:out.note};
      }`);
    return src;
  },

  'email-subject-line-tester.html'(src) {
    src = src.replace(/var SECT = '===SECTION===';\s*\n\s*\}/, "var SECT = '===SECTION===';");
    src = ensureHelper(src);
    src = src.replace(
      /'Analyze this email subject line and respond with:[\s\S]*?best first\)\.'/,
      `'Analyze this email subject line. ${SECT_INSTR} Section titles: Score, Analysis, Alternative 1, Alternative 2, Alternative 3, Alternative 4, Alternative 5. Score section: number out of 100 only.'`
    );
    src = src.replace(/function parseResponse[\s\S]*?return \{ score: score[\s\S]*?\};\s*\}/,
      `function parseResponse(raw){
        var blocks=parseSectionBlocks(raw);
        var score=50, analysis='', alts=[];
        blocks.forEach(function(b){
          var t=(b.title||'').toLowerCase();
          var body=(b.body||'').trim();
          if(t.indexOf('score')!==-1){ var m=body.match(/\\d{1,3}/); if(m) score=Math.min(100,Math.max(0,parseInt(m[0],10))); }
          else if(t.indexOf('analysis')!==-1) analysis=body;
          else if(t.indexOf('alternative')!==-1||t.indexOf('alt')!==-1){
            var lines=body.split(/\\n/); var subj=(lines[0]||'').trim(); var why=lines.slice(1).join('\\n').trim();
            if(subj) alts.push({subject:subj,why:why});
          }
        });
        if(!analysis && !alts.length && raw.trim()) analysis=raw.trim();
        return {score:score,analysis:analysis,alternatives:alts.slice(0,5)};
      }`);
    return src;
  },

  'instagram-reels-script-writer.html'(src) {
    src = ensureHelper(src);
    src = src.replace(
      /'Generate a complete Instagram Reels script[\s\S]*?hashtags\.'/,
      `'Generate a complete Instagram Reels script. ${SECT_INSTR} Section titles: Hook, Scene 1, Scene 2 (add scenes as needed), Caption.'`
    );
    src = src.replace(/function parseScript[\s\S]*?return \{ hook: hook[\s\S]*?\};\s*\}/,
      `function parseScript(raw){
        var blocks=parseSectionBlocks(raw);
        var hook='', scenes=[], caption='';
        blocks.forEach(function(b){
          var t=(b.title||'').toLowerCase();
          var body=(b.body||'').trim();
          if(t.indexOf('hook')!==-1) hook=body;
          else if(t.indexOf('scene')!==-1) scenes.push(body);
          else if(t.indexOf('caption')!==-1) caption=body;
        });
        if(!hook && !scenes.length) hook=(raw||'').trim();
        return {hook:hook,scenes:scenes,caption:caption};
      }`);
    return src;
  },

  'youtube-title-optimizer.html'(src) {
    src = ensureHelper(src);
    src = src.replace(
      /'Analyze the given YouTube title[\s\S]*?emotional triggers\.'/,
      `'Analyze the given YouTube title and score it 0-100. ${SECT_INSTR} Section titles: Score, Analysis, SEO Titles, CTR Titles, Hybrid Titles, Tips.'`
    );
    return src;
  },

  'company-culture-decoder.html'(src) {
    src = src.replace(/var SECT = '===SECTION===', DECODED='---DECODED---';/, "var SECT = '===SECTION===';" + HELPER);
    src = src.replace(
      /'Decode company culture from the pasted text\. Separate sections with exactly '\+SECT\+' then a section title and body\. Start with '\+DECODED\+' culture summary if helpful\. Be candid about red\/green flags\. Plain text\.'/,
      `'Decode company culture from the pasted text. ${SECT_INSTR} Include sections such as Decoded culture summary, Red flags, Green flags, Scorecard, Interview questions. Be candid. Plain text.'`
    );
    src = src.replace(/---SECTION---/g, '===SECTION===');
    src = src.replace(/---DECODED---/g, '===SECTION===');
    src = src.replace(/---SCORECARD---/g, '===SECTION===');
    return src;
  },

  'ftc-compliance-checker.html'(src) {
    src = ensureHelper(src);
    return src;
  },
};

function main() {
  let n = 0;
  for (const [file, fn] of Object.entries(patches)) {
    if (patch(file, fn)) {
      n++;
      console.log('fixed parsers', file);
    }
  }
  console.log('parser files fixed:', n);
}

if (require.main === module) main();

module.exports = { patches, ensureHelper, HELPER, SECT_INSTR };
