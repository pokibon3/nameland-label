// 1D barcode encoders. Each returns { modules: Uint8Array (1 = bar), text }
// where `text` is the human-readable line printed under the bars.

export const BARCODE_TYPES = [
  { v: 'code128', label: 'CODE128（英数字）' },
  { v: 'ean13', label: 'JAN / EAN-13（12〜13桁）' },
  { v: 'ean8', label: 'EAN-8（7〜8桁）' },
];

// Code 128 bar/space widths for symbol values 0..106 (106 = stop, 13 modules).
const C128 = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 ' +
  '221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 ' +
  '212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 ' +
  '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 ' +
  '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 ' +
  '214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232 2331112'
).split(' ');
const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const CODE_C = 99;
const STOP = 106;

function widthsToModules(widths, out) {
  let bar = true;
  for (const ch of widths) {
    for (let i = 0; i < Number(ch); i++) out.push(bar ? 1 : 0);
    bar = !bar;
  }
}

function encode128(data) {
  for (const ch of data) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) throw new Error('CODE128 は半角英数字と記号だけ使えます');
  }
  if (!data) throw new Error('バーコードの内容を入力してください');

  // Subset B for text, switching to C for runs of 4+ digits (2 digits per symbol).
  const values = [];
  let i = 0;
  let set = null;
  const digitRun = (from) => {
    let n = 0;
    while (from + n < data.length && /[0-9]/.test(data[from + n])) n++;
    return n;
  };
  while (i < data.length) {
    const run = digitRun(i);
    const useC = run >= 4 || (run >= 2 && run === data.length - i && set === null && run % 2 === 0);
    if (useC) {
      if (set === null) values.push(START_C);
      else if (set !== 'C') values.push(CODE_C);
      set = 'C';
      const pairs = Math.floor(run / 2);
      for (let p = 0; p < pairs; p++) {
        values.push(Number(data.substr(i, 2)));
        i += 2;
      }
      continue;
    }
    if (set === null) values.push(START_B);
    else if (set !== 'B') values.push(CODE_B);
    set = 'B';
    values.push(data.charCodeAt(i) - 32);
    i++;
  }
  let sum = values[0];
  for (let k = 1; k < values.length; k++) sum += values[k] * k;
  values.push(sum % 103, STOP);

  const modules = [];
  for (const v of values) widthsToModules(C128[v], modules);
  return { modules: Uint8Array.from(modules), text: data };
}

const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = EAN_L.map((l) => [...l].map((b) => (b === '1' ? '0' : '1')).reverse().join(''));
const EAN_R = EAN_L.map((l) => [...l].map((b) => (b === '1' ? '0' : '1')).join(''));
const EAN13_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

// weights alternate from the rightmost data digit: 3, 1, 3, ...
function eanCheck(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    sum += Number(digits[digits.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  }
  return String((10 - (sum % 10)) % 10);
}

function eanDigits(data, len, name) {
  const d = data.replace(/[\s-]/g, '');
  if (!/^[0-9]+$/.test(d)) throw new Error(`${name} は数字だけ使えます`);
  if (d.length === len - 1) return d + eanCheck(d);
  if (d.length === len) {
    if (eanCheck(d.slice(0, -1)) !== d.slice(-1)) throw new Error(`${name} のチェックデジットが正しくありません`);
    return d;
  }
  throw new Error(`${name} は ${len - 1} 桁（チェックデジットなし）か ${len} 桁で入力してください`);
}

function encodeEan13(data) {
  const d = eanDigits(data, 13, 'JAN/EAN-13');
  const parity = EAN13_PARITY[Number(d[0])];
  let bits = '101';
  for (let i = 1; i <= 6; i++) bits += (parity[i - 1] === 'L' ? EAN_L : EAN_G)[Number(d[i])];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += EAN_R[Number(d[i])];
  bits += '101';
  return { modules: Uint8Array.from(bits, Number), text: d };
}

function encodeEan8(data) {
  const d = eanDigits(data, 8, 'EAN-8');
  let bits = '101';
  for (let i = 0; i < 4; i++) bits += EAN_L[Number(d[i])];
  bits += '01010';
  for (let i = 4; i < 8; i++) bits += EAN_R[Number(d[i])];
  bits += '101';
  return { modules: Uint8Array.from(bits, Number), text: d };
}

export function encodeBarcode(type, data) {
  if (type === 'ean13') return encodeEan13(data);
  if (type === 'ean8') return encodeEan8(data);
  return encode128(data);
}
