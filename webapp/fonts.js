// Font catalogue: built-in choices ("標準") and every installed font ("Mac")
// via the Local Font Access API (Chrome/Edge; asks for permission once).

export const SAMPLE_TEXT = 'あいうえおABCDEFabcdef';

const quote = (name) => `"${name.replace(/["\\]/g, '\\$&')}"`;

function preset(family, label, fallback, styles) {
  return { source: 'preset', family, label, css: `${quote(family)}, ${fallback}`, styles };
}

export const PRESETS = [
  preset('Hiragino Sans', 'ヒラギノ角ゴシック', 'sans-serif',
    [{ label: 'W3', weight: '300' }, { label: 'W6', weight: '600' }, { label: 'W8', weight: '800' }]),
  preset('Hiragino Mincho ProN', 'ヒラギノ明朝', 'serif',
    [{ label: 'W3', weight: 'normal' }, { label: 'W6', weight: 'bold' }]),
  preset('Hiragino Maru Gothic ProN', 'ヒラギノ丸ゴ', 'sans-serif', [{ label: 'W4', weight: 'normal' }]),
  preset('YuGothic', '游ゴシック', 'sans-serif',
    [{ label: 'Medium', weight: '500' }, { label: 'Bold', weight: 'bold' }]),
  preset('YuMincho', '游明朝', 'serif',
    [{ label: 'Medium', weight: '500' }, { label: 'Demibold', weight: '600' }]),
  preset('Klee', 'クレー', 'sans-serif', [{ label: 'Medium', weight: '500' }, { label: 'Demibold', weight: '600' }]),
  preset('Tsukushi A Round Gothic', '筑紫A丸ゴシック', 'sans-serif',
    [{ label: 'Regular', weight: 'normal' }, { label: 'Bold', weight: 'bold' }]),
  preset('Helvetica Neue', 'Helvetica Neue', 'Arial, sans-serif',
    [{ label: 'Regular', weight: 'normal' }, { label: 'Bold', weight: 'bold' }]),
  preset('Avenir Next', 'Avenir Next', 'sans-serif',
    [{ label: 'Regular', weight: 'normal' }, { label: 'Demi Bold', weight: '600' }, { label: 'Heavy', weight: '800' }]),
  preset('Menlo', 'Menlo（等幅）', 'monospace',
    [{ label: 'Regular', weight: 'normal' }, { label: 'Bold', weight: 'bold' }]),
];

export const supportsLocalFonts = 'queryLocalFonts' in window;

let localFamilies = null; // [{ source: 'local', family, label, css, styles: [{ label, ps }] }]

export function localFonts() {
  return localFamilies;
}

export async function localFontPermission() {
  if (!supportsLocalFonts) return 'unsupported';
  try {
    return (await navigator.permissions.query({ name: 'local-fonts' })).state;
  } catch {
    return 'prompt';
  }
}

export async function loadLocalFonts() {
  if (localFamilies) return localFamilies;
  const fonts = await window.queryLocalFonts();
  const byFamily = new Map();
  for (const f of fonts) {
    if (!byFamily.has(f.family)) byFamily.set(f.family, []);
    byFamily.get(f.family).push({ label: f.style, ps: f.postscriptName });
  }
  localFamilies = [...byFamily.entries()]
    .map(([family, styles]) => ({ source: 'local', family, label: family, css: `${quote(family)}, sans-serif`, styles }))
    .sort((a, b) => a.family.localeCompare(b.family, 'ja'));
  return localFamilies;
}

export function findFamily(choice) {
  if (choice.source === 'local' && localFamilies) {
    const f = localFamilies.find((x) => x.family === choice.family);
    if (f) return f;
  }
  return PRESETS.find((x) => x.family === choice.family) || null;
}

const faces = new Map(); // postscript name -> CSS family alias

async function registerFace(ps) {
  if (faces.has(ps)) return faces.get(ps);
  const alias = `lf-${ps}`;
  const face = new FontFace(alias, `local(${quote(ps)})`);
  await face.load();
  document.fonts.add(face);
  faces.set(ps, alias);
  return alias;
}

export function defaultStyle(fam) {
  const regular = fam.styles.find((s) => /^(regular|normal|book|roman|w3|medium|w4)$/i.test(s.label));
  return regular || fam.styles[0];
}

/**
 * Resolve a saved choice { source, family, style } to what the canvas needs.
 * A Mac font style is loaded by PostScript name as its own face so every
 * installed weight/width is reachable, not just normal and bold.
 */
export async function resolveFont(choice) {
  const fam = findFamily(choice) || PRESETS[0];
  const style = fam.styles.find((s) => s.label === choice.style) || defaultStyle(fam);
  if (style.ps) {
    try {
      const alias = await registerFace(style.ps);
      return { css: `${quote(alias)}, ${fam.css}`, weight: 'normal', family: fam, style };
    } catch {
      // fall back to the family name below
    }
  }
  await document.fonts.load(`${style.weight || 'normal'} 20px ${fam.css}`).catch(() => {});
  return { css: fam.css, weight: style.weight || 'normal', family: fam, style };
}
