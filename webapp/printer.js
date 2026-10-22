// KL-SP100 (internal model "GY-175") print protocol.
// Recovered from LABEL DESIGN MAKER's NativeApp (class Lateco_BIZ_Printer).
// Every command is a 16-byte zero-padded packet on the bulk OUT endpoint;
// replies are read from bulk IN (max 64 bytes). 0x06 = ACK.

export const USB_FILTER = { vendorId: 0x07cf, productId: 0x4206 };
export const BLE_SERVICE_UUID = 'ac120000-63a6-4f4e-b093-ee6cf341e5c7';
const BLE_COMMAND_UUID = 'ac120001-63a6-4f4e-b093-ee6cf341e5c7';
const BLE_RESPONSE_UUID = 'ac120002-63a6-4f4e-b093-ee6cf341e5c7';

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

// BLE framing recovered from LABEL DESIGN MAKER's CHLHomeLabelTransporter.
// The printer exposes one write characteristic and one notify characteristic.
// Command bytes are the same as USB, with a one-byte direction prefix and a
// five-bit sequence header. Raster data is encrypted and sent in MTU-sized
// chunks after the connection negotiates a key and payload size.
const BLE_TABLES = (() => {
  const s =
    '77f58159a9d20c4b15771657d0c8bed3052d23d07d68d0199795208faa829f36' +
    '35be1afe7e5fa8cfe2ecefd919b276a9b30d57ec91277286646a8cd3c07557a6' +
    '0507904d46fdfda1d42111cc7f8853b87cceade06ec3a2423c37f3208f385810' +
    '89d38c6531b933cb22f5b33fe0a548b14eb86de5c95b75ef3e5ae15f9f5e209f' +
    '7eb44ad6b3b3cbe08e5619958d1577be52e229f6fb0586183454f0ca1760ad68' +
    'e75ced8edd12eca3386b05d8becb48f050ce8a178a0235fda1cc9a627e1063f6' +
    'effa5ff902e348377ed2f97bcdbb7121587f48fbcda462a9457be30390601d80' +
    'eafecc7496a3fd56b1b483d88f9ddeb56c59f32b1751c8586ef18312b73ea0bb' +
    '94d035075c90e631bdfa06d93c1ddeea7040bbceb577be0816dec8682f84f60c' +
    'a33b1281e59c95465b4526f8c6219897db789b8ef4cc9c2cf46c0d9b78854645' +
    '9ee6171cbc3671f70715f359268e6e386e728cbf42835118ba8f2e8bfab5dcba' +
    '56aa0cddcb992dce7639392a198eba90a40ed27dde43a7a6d8ed2008d5f0632a';
  const bytes = new Uint8Array(s.match(/../g).map((x) => parseInt(x, 16)));
  return [bytes.subarray(0, 128), bytes.subarray(128, 256), bytes.subarray(256)];
})();

function permuteBits(src) {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    const at = (n) => src[(i + n) & 7];
    out[i] = (at(4) & 0x88) | (at(1) & 0x40) | (at(2) & 0x20) |
      (at(3) & 0x10) | (at(5) & 0x04) | (at(6) & 0x02) | (at(7) & 0x01);
  }
  return out;
}

class BleRasterCipher {
  constructor(key) {
    if (key.length < 16) throw new Error('BLE暗号鍵の長さが不正です');
    const [a, b, c] = BLE_TABLES;
    this.stream = new Uint8Array(128);
    for (let i = 0; i < 128; i++) {
      this.stream[i] = a[(key[15] + i) & 0x7f] ^ b[(key[0] + i) & 0x7f];
    }
    let state = Uint8Array.of(key[1], key[4], key[13], key[14], key[8], key[9], key[5], key[11]);
    for (const k of [key[7], key[3], key[12], key[2], key[10]]) {
      state = permuteBits(state.map((v) => v ^ k));
    }
    for (let i = 0; i < 8; i++) state[i] ^= c[(key[6] + i) & 0x7f];
    this.state = state;
    this.offset = 0;
  }

  encrypt(data) {
    if (data.length % 8) throw new Error('BLE画像データは8バイト単位である必要があります');
    const out = new Uint8Array(data.length);
    const order = [5, 0, 4, 6, 7, 2, 1, 3];
    for (let p = 0; p < data.length; p += 8) {
      for (let i = 0; i < 8; i++) {
        out[p + i] = data[p + i] ^ this.state[i] ^ this.stream[(this.offset + i) & 0x7f];
      }
      const next = permuteBits(out.subarray(p, p + 8));
      this.state = Uint8Array.from(order, (i) => next[i]);
      this.offset = (this.offset + 8) & 0x7f;
    }
    return out;
  }
}

export class BleTransport {
  constructor(device) {
    this.device = device;
    this.sequence = 0;
    this.notifications = [];
    this.waiters = [];
    this.responses = [];
    this.trace = [];
  }

  static async request() {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE_UUID] }],
    });
    return BleTransport.open(device);
  }

  static async reconnect(deviceOrId = null) {
    if (deviceOrId && typeof deviceOrId === 'object' && deviceOrId.gatt) {
      return BleTransport.open(deviceOrId, { reconnecting: true });
    }
    if (!navigator.bluetooth.getDevices) return null;
    let devices = await navigator.bluetooth.getDevices();
    // The Web Bluetooth specification also exposes authorized devices on the
    // Bluetooth permission result. Use it as a fallback for Chrome versions
    // whose getDevices() implementation temporarily returns an empty list.
    if (!devices.length && deviceOrId && navigator.permissions?.query) {
      try {
        const permission = await navigator.permissions.query({
          name: 'bluetooth', deviceId: deviceOrId,
        });
        devices = Array.from(permission.devices || []);
      } catch { /* Bluetooth permission descriptors are not supported */ }
    }
    const device = (deviceOrId && devices.find((d) => d.id === deviceOrId)) ||
      devices.find((d) => d.name && d.name.startsWith('KL-SP100'));
    return device ? BleTransport.open(device, { reconnecting: true }) : null;
  }

  static async open(device, { reconnecting = false } = {}) {
    const t = new BleTransport(device);
    try {
      // Chrome can keep the previous page's GATT connection alive briefly
      // after an installed PWA window is closed. Reusing that stale server
      // makes service discovery fail forever on subsequent automatic retries.
      if (reconnecting && device.gatt.connected) {
        device.gatt.disconnect();
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(BLE_SERVICE_UUID);
      t.command = await service.getCharacteristic(BLE_COMMAND_UUID);
      t.response = await service.getCharacteristic(BLE_RESPONSE_UUID);
      t.onNotification = (e) => t.deliver(new Uint8Array(
        e.target.value.buffer, e.target.value.byteOffset, e.target.value.byteLength));
      t.response.addEventListener('characteristicvaluechanged', t.onNotification);
      await t.response.startNotifications();
      await t.negotiate();
      return t;
    } catch (e) {
      try { device.gatt.disconnect(); } catch { /* already disconnected */ }
      throw e;
    }
  }

  get name() {
    return `${this.device.name || 'KL-SP100'} (Bluetooth)`;
  }

  deliver(value) {
    this.recordTrace('<', value);
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.notifications.push(value);
  }

  nextNotification(timeoutMs = 10000) {
    if (this.notifications.length) return Promise.resolve(this.notifications.shift());
    return new Promise((resolve, reject) => {
      let timer;
      const done = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.waiters.push(done);
      timer = setTimeout(() => {
        const i = this.waiters.indexOf(done);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(this.timeoutError());
      }, timeoutMs);
    });
  }

  recordTrace(direction, value) {
    this.trace.push(`${direction} ${hex(value)}`);
    if (this.trace.length > 20) this.trace.shift();
  }

  timeoutError() {
    return new Error(`プリンターのBLE応答がありません（タイムアウト）\n\n通信トレース:\n${this.trace.join('\n')}`);
  }

  async frame(payload, {
    commandType = 0x80, text = false, timeoutMs = 10000, responseType = 0x40,
  } = {}) {
    this.sequence = (this.sequence + 1) & 0x1f;
    const header = commandType | (text ? 0x20 : 0) | this.sequence;
    const data = new Uint8Array(payload.length + 1);
    data[0] = header;
    data.set(payload, 1);
    const pending = responseType === null ? null : this.nextNotification(timeoutMs);
    this.recordTrace('>', data);
    await this.command.writeValueWithResponse(data);
    if (!pending) return null;
    const deadline = Date.now() + timeoutMs;
    let reply = await pending;
    // Ignore notifications for another frame class. This mirrors the APK's
    // state machine, which remains in command-wait until the expected class.
    while ((reply[0] & 0xe0) !== responseType) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw this.timeoutError();
      reply = await this.nextNotification(remaining);
    }
    return reply.subarray(1);
  }

  async negotiate() {
    await this.frame(Uint8Array.of(0x06), { responseType: 0x80 }); // device address
    await this.frame(Uint8Array.of(0x07, 0x06, 0x06, 0x00, 0x3c), { responseType: 0x80 });
    const size = await this.frame(Uint8Array.of(0x01), { responseType: 0x80 });
    if (size.length < 2) throw new Error('BLEペイロードサイズを取得できませんでした');
    this.payloadSize = size[0] | (size[1] << 8);
    const key = await this.frame(Uint8Array.of(0x02), { responseType: 0x80 });
    this.cipher = new BleRasterCipher(key);
  }

  static commandBytes(packet) {
    if (packet[0] !== 0x02) return packet.subarray(0, 1);
    const fixed = { 0x02: 8, 0x1a: 8, 0x01: 4, 0x1c: 5, 0x0d: 5,
      0x09: 11, 0x19: 5, 0x04: 4, 0x1d: 5 };
    return packet.slice(0, fixed[packet[1]] || Math.min(packet.length, 4 + packet[2] + (packet[3] << 8)));
  }

  async send(data) {
    if (data[0] === 0x02 && data[1] === 0xff) {
      await this.sendRaster(data.subarray(6));
      return;
    }
    const raw = BleTransport.commandBytes(data);
    const query = raw[0] === 0x02 && (raw[1] === 0x1a || raw[1] === 0x1d);
    const payload = new Uint8Array(raw.length + 1);
    payload[0] = query ? 0x20 : 0x01;
    payload.set(raw, 1);

    // 0x24/0x25 acquire and release exclusive printer access.
    if (raw[0] === 0x24) await this.frame(Uint8Array.of(0x04), { responseType: 0x80 });
    const reply = await this.frame(payload, {
      commandType: 0x40,
      timeoutMs: raw[0] === 0x0c ? 120000 : 10000,
    });
    if (raw[0] === 0x25) await this.frame(Uint8Array.of(0x05), { responseType: 0x80 });
    this.responses.push(reply);
  }

  async sendRaster(data) {
    const chunkSize = Math.floor((this.payloadSize - 6) / 8) * 8;
    if (chunkSize < 8) throw new Error(`BLEペイロードサイズが小さすぎます (${this.payloadSize})`);
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const used = Math.min(chunkSize, data.length - offset);
      const plain = new Uint8Array(chunkSize);
      plain.set(data.subarray(offset, offset + used));
      const encrypted = this.cipher.encrypt(plain);
      const payload = new Uint8Array(5 + encrypted.length);
      payload.set([0x00, 0x02, 0xfe, used & 0xff, (used >> 8) & 0xff]);
      payload.set(encrypted, 5);
      await this.frame(payload, { commandType: 0x40, text: true, responseType: null });
    }
  }

  async recv(timeoutMs = 10000) {
    if (this.responses.length) return this.responses.shift();
    if (!timeoutMs) return new Promise((resolve) => {
      const poll = () => this.responses.length ? resolve(this.responses.shift()) : setTimeout(poll, 20);
      poll();
    });
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (this.responses.length) return this.responses.shift();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw this.timeoutError();
  }

  async close() {
    // Disconnect synchronously first. `pagehide` does not give the awaited
    // stopNotifications call enough time when an installed app is closed.
    try { this.device.gatt.disconnect(); } catch { /* disconnected */ }
    try { await this.response.stopNotifications(); } catch { /* disconnected */ }
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
