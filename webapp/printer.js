// KL-SP100 (internal model "GY-175") print protocol.
// Recovered from LABEL DESIGN MAKER's NativeApp (class Lateco_BIZ_Printer).
// Every command is a 16-byte zero-padded packet on the bulk OUT endpoint;
// replies are read from bulk IN (max 64 bytes). 0x06 = ACK.

export const USB_FILTER = { vendorId: 0x07cf, productId: 0x4206 };

const ACK = 0x06;
const NAK = 0x15;
const BUSY_HOT = 0x16; // startPrint: print head too hot, wait and retry

// Tape index -> code reported by the printer (getTapeInfo reply byte 4)
export const TAPE_CODES = [0x05, 0x81, 0x85, 0x83, 0x87, 0x86];
// Tape index -> print head dots across the tape (raster height)
export const HEAD_DOTS = [16, 32, 56, 80, 128, 144];
export const TAPES = [
  { index: 0, label: '3.5mm' },
  { index: 1, label: '6mm' },
  { index: 2, label: '9mm' },
  { index: 3, label: '12mm' },
  { index: 4, label: '18mm' },
  { index: 5, label: '24mm' },
];
export const DOTS_PER_MM = 8;
// margin index -> blank feed at each end in mm (printer adds it)
export const SIDE_MARGIN_MM = [3, 10, 21];

const AUTOFEED = [0x40, 0x80, 0x02];       // by margin index
const DENSITY = [0xfe, 0xff, 0x00, 0x01, 0x02]; // by printLevel 1..5
// [endCut][cutting]; cutting 0=full, 1=full+half, 2=none
const CUT = [[0x00, 0x01, 0x0f], [0x80, 0x81, 0x8f]];

function packet(...bytes) {
  const p = new Uint8Array(16);
  p.set(bytes);
  return p;
}

const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(' ');

export class UsbTransport {
  constructor(device) {
    this.device = device;
  }

  static async request() {
    const device = await navigator.usb.requestDevice({ filters: [USB_FILTER] });
    return UsbTransport.open(device);
  }

  static async reconnect() {
    const devices = await navigator.usb.getDevices();
    const device = devices.find(
      (d) => d.vendorId === USB_FILTER.vendorId && d.productId === USB_FILTER.productId);
    return device ? UsbTransport.open(device) : null;
  }

  static async open(device) {
    const t = new UsbTransport(device);
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    const iface = device.configuration.interfaces[0];
    await device.claimInterface(iface.interfaceNumber);
    const eps = iface.alternate.endpoints;
    t.epOut = eps.find((e) => e.direction === 'out' && e.type === 'bulk').endpointNumber;
    t.epIn = eps.find((e) => e.direction === 'in' && e.type === 'bulk').endpointNumber;
    return t;
  }

  get name() {
    return this.device.productName || 'KL-SP100';
  }

  async send(data) {
    const r = await this.device.transferOut(this.epOut, data);
    if (r.status !== 'ok') throw new Error(`USB送信エラー: ${r.status}`);
  }

  async recv(timeoutMs = 10000) {
    const xfer = this.device.transferIn(this.epIn, 64).then((r) => {
      if (r.status !== 'ok') throw new Error(`USB受信エラー: ${r.status}`);
      return new Uint8Array(r.data.buffer);
    });
    if (!timeoutMs) return xfer;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('プリンターの応答がありません（タイムアウト）')), timeoutMs);
    });
    try {
      return await Promise.race([xfer, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async close() {
    try { await this.device.close(); } catch { /* already closed */ }
  }
}

export class KLSP100 {
  constructor(transport, log = () => {}) {
    this.t = transport;
    this.log = log;
  }

  async cmd(name, pkt, { expectAck = true, timeoutMs = 10000 } = {}) {
    this.log(`> ${name}: ${hex(pkt.subarray(0, 12))}`);
    await this.t.send(pkt);
    const r = await this.t.recv(timeoutMs);
    this.log(`< ${name}: ${hex(r.subarray(0, 12))}`);
    if (expectAck && r[0] !== ACK) {
      throw new Error(`${name} が失敗しました (応答 0x${r[0].toString(16)})`);
    }
    return r;
  }

  start() { return this.cmd('start', packet(0x24)); }
  end() { return this.cmd('end', packet(0x25)); }

  async deviceCode() {
    const r = await this.cmd('deviceCode', packet(0x02, 0x02, 0x04, 0x00, 0x01, 0x07, 0x05, 0x01), { expectAck: false });
    if (r[0] === NAK) throw new Error('プリンターがこの機種として応答しませんでした');
    if (r[0] !== ACK) throw new Error(`deviceCode が失敗しました (応答 0x${r[0].toString(16)})`);
  }

  // Returns { index, code, status }; index is -1 when the tape is unknown.
  async tapeInfo() {
    const r = await this.cmd('tapeInfo', packet(0x02, 0x1a), { expectAck: false });
    const code = r[4];
    return { index: TAPE_CODES.indexOf(code), code, status: r[5] };
  }

  // One-shot query used by the UI's "テープ幅を読む" button.
  async readTape() {
    await this.start();
    try {
      await this.deviceCode();
      return await this.tapeInfo();
    } finally {
      await this.end().catch(() => {});
    }
  }

  /**
   * pages: array of { data: Uint8Array (column raster), widthDots }
   * opts: { tape, margin, density(1..5), copies, cutting(0..2), endCut(0|1), magnet }
   */
  async print(pages, opts, onProgress = () => {}) {
    const mode = opts.magnet ? 2 : 1;
    const copies = opts.copies;
    const total = pages.length * copies;

    await this.start();
    try {
      await this.deviceCode();

      const tape = await this.tapeInfo();
      if (tape.status & 0x03) throw new Error(`プリンターがテープ異常を返しました (状態 0x${tape.status.toString(16)})`);
      if (tape.index !== opts.tape) {
        const actual = tape.index >= 0 ? TAPES[tape.index].label : `不明(0x${tape.code.toString(16)})`;
        throw new Error(`テープ幅が違います: 設定 ${TAPES[opts.tape].label} / 装着 ${actual}`);
      }

      await this.cmd('reset', packet(0x02, 0x01));
      await this.cmd('speed', packet(0x02, 0x1c, 0x01, 0x00, (mode & 0x7d) ? 1 : 0));
      await this.cmd('autoFeed', packet(0x02, 0x0d, 0x01, 0x00, AUTOFEED[opts.margin]));
      await this.cmd('setup', packet(
        0x02, 0x09, 0x05, 0x00,
        opts.tape, 0x00,
        total & 0xff, (total >> 8) & 0xff,
        DENSITY[opts.density - 1],
        mode === 2 ? 0x05 : 0x00,
        0x00));
      await this.cmd('cut', packet(0x02, 0x19, 0x01, 0x00, CUT[opts.endCut][opts.cutting]));

      // per-copy unit: every copy sends all pages again
      let done = 0;
      for (let c = 0; c < copies; c++) {
        for (const page of pages) {
          await this.transfer(page.data);
          await this.waitBattery();
          await this.startPrint();
          onProgress(++done, total);
        }
      }

      await this.cmd('finish', packet(0x18), { expectAck: false }).catch(() => {});
    } finally {
      await this.end().catch(() => {});
    }
  }

  async transfer(data) {
    const n = data.length;
    const buf = new Uint8Array(6 + n);
    buf.set([0x02, 0xff, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
    buf.set(data, 6);
    this.log(`> data: ${n} bytes`);
    await this.t.send(buf);
    await this.cmd('endData', packet(0x02, 0x04));
  }

  async waitBattery() {
    const r = await this.cmd('power', packet(0x02, 0x1d, 0x01, 0x00, 0x01), { expectAck: false });
    if (r[4] !== 0) throw new Error('電源（電池残量）が不足しています');
  }

  async startPrint() {
    for (;;) {
      // no timeout: the reply comes after the label has been printed
      const r = await this.cmd('print', packet(0x0c), { expectAck: false, timeoutMs: 0 });
      if (r[0] === ACK) return;
      if (r[0] !== BUSY_HOT) throw new Error(`印刷に失敗しました (応答 0x${r[0].toString(16)})`);
      this.log('ヘッド温度が高いため待機しています…');
      await new Promise((ok) => setTimeout(ok, 5000));
    }
  }
}
