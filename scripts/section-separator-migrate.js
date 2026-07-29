/**
 * One-shot migration helper: ===SECTION=== separator audit + sample-render checks.
 * Run: node scripts/section-separator-migrate.js
 */
const fs = require('fs');
const path = require('path');

const BACKEND = path.join(__dirname, '..', 'api', 'ai-tools-public.js');
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'creatorversed-standalone-tools');

const SECTION_INSTR =
  'Separate each section with a line containing only ===SECTION===. After each marker, put the section title on its own line, then the content. Do not use --- dividers or named ---TOKEN--- markers.';

const TOOLS = [
  {
    html: 'resume-headline-generator.html',
    backendKey: 'resume-headline',
    sample: 'Match score preamble\n===SECTION===\nMetric-Led Headlines\nHeadline one\nHeadline two\n===SECTION===\nAuthority-Led Headlines\nHeadline three',
    cardMin: 2,
  },
  {
    html: 'job-description-analyzer.html',
    backendKey: 'job-analyzer',
    sample: 'Match score: 72\n===SECTION===\nRED FLAGS\nFlag one\n===SECTION===\nGREEN FLAGS\nFlag two',
    cardMin: 2,
  },
  {
    html: 'content-repurposing-planner.html',
    backendKey: 'content-repurpose',
    sample: '===SECTION===\nQuick Wins\nIdea one\n===SECTION===\nMedium Effort\nIdea two',
    cardMin: 2,
  },
  {
    html: 'linkedin-profile-analyzer.html',
    backendKey: 'linkedin-analyzer',
    sample: 'Score: 65\n===SECTION===\nHeadline\nNeeds work\n===SECTION===\nAbout\nGood start',
    cardMin: 2,
  },
  {
    html: 'brand-voice-analyzer.html',
    backendKey: 'brand-voice',
    sample: '===SECTION===\nTone\nWarm and direct\n===SECTION===\nVocabulary\nSimple words',
    cardMin: 2,
  },
  {
    html: 'project-brief-generator.html',
    backendKey: 'project-brief',
    sample: '===SECTION===\nExecutive Summary\nSummary text\n===SECTION===\nObjectives\nObjective one',
    cardMin: 2,
  },
  {
    html: 'meeting-notes-generator.html',
    backendKey: 'meeting-notes',
    sample: '===SECTION===\nMeeting Summary\nWe discussed launch\n===SECTION===\nAction Items\n1. Send recap',
    cardMin: 2,
  },
  {
    html: 'contract-template-generator.html',
    backendKey: 'contract-template',
    sample: '===SECTION===\nParties\nCreator and Brand\n===SECTION===\nScope\nDeliverables listed',
    cardMin: 2,
  },
  {
    html: 'scope-of-work-generator.html',
    backendKey: 'scope-of-work',
    sample: '===SECTION===\nProject Overview\nOverview text\n===SECTION===\nDeliverables\nItem one',
    cardMin: 2,
  },
  {
    html: 'company-culture-decoder.html',
    backendKey: 'culture-decoder',
    sample: '===SECTION===\nDecoded Culture\nPlain English summary\n===SECTION===\nRed Flags\nFlag one',
    cardMin: 2,
  },
  {
    html: 'ftc-compliance-checker.html',
    backendKey: 'ftc-checker',
    sample: 'Score: 40\n===SECTION===\nViolations\nMissing disclosure\n===SECTION===\nFix\nAdd #ad',
    cardMin: 2,
  },
  {
    html: 'caption-writer-pro.html',
    backendKey: 'caption-writer',
    sample: '===SECTION===\nShort Caption\nQuick hook\n===SECTION===\nMedium Caption\nHook and CTA',
    cardMin: 2,
  },
  {
    html: 'email-subject-line-tester.html',
    backendKey: 'email-subject-line',
    sample: '===SECTION===\nScore\n72\n===SECTION===\nAnalysis\nToo long\n===SECTION===\nAlternative 1\nBetter subject',
    cardMin: 2,
  },
  {
    html: 'tagline-generator.html',
    backendKey: 'tagline',
    sample: '===SECTION===\nTagline 1\nJust Do It\n===SECTION===\nTagline 2\nThink Different',
    cardMin: 2,
  },
  {
    html: 'tiktok-video-idea-generator.html',
    backendKey: 'tiktok-ideas',
    sample: '===SECTION===\nIdea 1\nHook and concept\n===SECTION===\nIdea 2\nAnother concept',
    cardMin: 2,
  },
  {
    html: 'value-proposition-generator.html',
    backendKey: 'value-proposition',
    sample: '===SECTION===\nOne-liner\nI help creators grow\n===SECTION===\nShort\nTwo sentence version',
    cardMin: 2,
  },
  {
    html: 'origin-story-creator.html',
    backendKey: 'origin-story',
    sample: '===SECTION===\nShort Version\nTwo sentences here.\n===SECTION===\nFull Version\nParagraph one.\n\nParagraph two.',
    cardMin: 2,
  },
  {
    html: 'youtube-title-optimizer.html',
    backendKey: 'youtube-titles',
    sample: '===SECTION===\nScore\n68\n===SECTION===\nSEO Titles\nTitle one\nTitle two',
    cardMin: 2,
  },
  {
    html: 'instagram-reels-script-writer.html',
    backendKey: 'reels-script',
    sample: '===SECTION===\nHook\nStop scrolling now\n===SECTION===\nScene 1\nVisual and line\n===SECTION===\nCaption\nPost caption here',
    cardMin: 2,
  },
  {
    html: 'brand-pitch-generator.html',
    backendKey: 'brand-pitch',
    sample: '===SECTION===\nShort cold email\nSubject: Partnership\nBody text\n===SECTION===\nDetailed pitch\nSubject: Detailed\nBody\n===SECTION===\nDM version\nShort DM text',
    cardMin: 2,
  },
];

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function countCardsFromParts(parts) {
  return parts.filter((p) => p.trim()).length;
}

function genericParseSections(text) {
  const parts = text.split(/\n?\s*===SECTION===\s*\n?/).map((p) => p.trim()).filter(Boolean);
  return parts.map((chunk) => {
    const nl = chunk.indexOf('\n');
    if (nl === -1) return { title: chunk, body: '' };
    return { title: chunk.slice(0, nl).trim(), body: chunk.slice(nl + 1).trim() };
  });
}

function audit() {
  const backendSrc = read(BACKEND);
  const rows = [];

  for (const tool of TOOLS) {
    const htmlPath = path.join(FRONTEND_DIR, tool.html);
    const err = [];
    let html = '';
    if (!fs.existsSync(htmlPath)) {
      err.push('html missing');
    } else {
      html = read(htmlPath);
    }

    const keyMarker = `'${tool.backendKey}':`;
    const start = backendSrc.indexOf(keyMarker);
    let backendOk = false;
    if (start !== -1) {
      const sysIdx = backendSrc.indexOf('system: `', start);
      const endIdx = backendSrc.indexOf('${TONE_INSTRUCTIONS}`', sysIdx);
      if (sysIdx !== -1 && endIdx !== -1) {
        const block = backendSrc.slice(sysIdx, endIdx);
        backendOk = block.includes('===SECTION===');
      }
    }

    const rendererOk = html.includes('===SECTION===') &&
      !html.includes("'---SECTION---'") &&
      !html.match(/var\s+\w+\s*=\s*'---[A-Z_]+---'/);

    let cards = 0;
    let sampleErr = '';
    try {
      const sections = genericParseSections(tool.sample);
      cards = sections.length;
      if (cards < tool.cardMin) sampleErr = `expected >=${tool.cardMin} cards, got ${cards}`;
    } catch (e) {
      sampleErr = e.message;
    }

    rows.push({
      tool: tool.html.replace('.html', ''),
      backend: backendOk ? 'Y' : 'N',
      renderer: rendererOk ? 'Y' : 'N',
      cards: cards >= tool.cardMin ? 'Y' : 'N',
      error: err.concat(sampleErr).filter(Boolean).join('; ') || '',
    });
  }

  return rows;
}

if (require.main === module) {
  const rows = audit();
  console.log('tool | backend | renderer | sample-cards | error');
  rows.forEach((r) => {
    console.log(`${r.tool} | ${r.backend} | ${r.renderer} | ${r.cards} | ${r.error}`);
  });
}

module.exports = { TOOLS, SECTION_INSTR, audit, genericParseSections };
