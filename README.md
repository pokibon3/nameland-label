# NAME LAND i-ma KL-SP100 ラベルアプリ

カシオ ネームランド KL-SP100 を USB または Bluetooth でつないで、ブラウザからラベルを作成・印刷する Web アプリです。

**アプリ:** https://pokibon3.github.io/nameland-label/

## 必要なもの

- Chrome または Edge（WebUSB / Web Bluetooth を使うため。Safari・Firefox は非対応）
- USB または Bluetooth で接続できる KL-SP100

## できること

- テキスト（Mac にインストールされた全フォント対応）、QR コード、バーコード（CODE128 / JAN・EAN-13 / EAN-8）
- 枠、記号・絵文字、白黒反転
- テープ幅 3.5〜24mm、装着テープ幅の読み取り
- USB / Bluetooth の切り替え
- 前回許可した Bluetooth プリンターへの起動時・切断後の自動再接続
- ラベルの保存・呼び出し（任意のフォルダに JSON ファイルとして保存）
- インストールしてアプリとして使用（オフライン起動可）

## 接続する

画面右上で `USB` または `Bluetooth` を選び、「接続」を押します。

Bluetooth を初めて使う場合は、ブラウザの機器一覧から `KL-SP100_…` を選択してください。接続に成功した機器は記憶され、次回起動時に自動接続します。アプリ終了時には BLE 接続を解放し、プリンター側からリンクが切断された場合も同じ機器へ自動再接続します。ユーザーが「切断」を押した場合は自動再接続しません。Bluetooth 権限を削除した場合だけ、もう一度機器を選択してください。

Chrome で起動時の機器選択を省略するには、`chrome://flags/#enable-web-bluetooth-new-permissions-backend` を開き、`Use the new permissions backend for Web Bluetooth` を `Enabled` にして Chrome を再起動してください。その後に一度接続すると、許可済み機器を次回起動時に取得できます。このフラグが無効な環境では、Web Bluetooth の制約によりアプリを起動するたびに機器選択が必要です。

再接続時は、許可済み機器の BLE 広告を最大 5 秒待ってから接続します。広告が見えなくても接続を試みます（プリンターは印刷が終わるたびに BLE 接続を切るため、そのつど自動で再接続します）。`Bluetooth Device is no longer in range` または「Bluetoothプリンターが見つかりません」と表示される場合は、プリンターの電源、Macとの距離、ほかの端末や LABEL DESIGN MAKER が接続していないことを確認してください。

テープ幅を読み取れることを確認してから印刷してください。

## ローカルで動かす

```sh
webapp/serve.sh
```

`http://localhost:8123` を Chrome で開きます。ローカルサーバーは開発中の古い JavaScript が残らないよう、キャッシュを無効化して配信します。

## Claude Code から印刷する（MCP）

`mcp/nameland_mcp.py` は、Claude Code から指示してラベルを印刷するための MCP サーバーです（Python 標準ライブラリのみ）。このリポジトリを Claude Code で開くと `.mcp.json` から自動で起動し、初回だけ利用の許可を求められます。ほかのフォルダからも使う場合はユーザー設定に登録します。

```sh
claude mcp add -s user nameland -- python3 /path/to/NAMELAND/mcp/nameland_mcp.py
```

- MCP サーバーが `http://localhost:8123` でアプリを配信します。`serve.sh` を別に起動する必要はありません（ポートが使用中なら、そのサーバーを使います）
- 印刷を頼んだときにアプリのタブがなければ Chrome で開き、プリンターの自動接続を待ってから印刷します
- 印刷の描画と USB / Bluetooth 通信はアプリがそのまま行うので、アプリで印刷したものと同じ結果になります
- 指定しなかった項目（フォント、枠など）はアプリの現在の設定を使います。テープ幅を指定しない場合は装着テープを読み取ります

ツール: `print_label`（印刷）、`preview_label`（印刷される画像を確認）、`print_image` / `preview_image`（画像ファイルの印刷・確認）、`printer_status`（接続状態・テープ幅）

### 画像を印刷する

`print_image` は PNG / JPEG / GIF / WebP / BMP / SVG ファイルを印刷します。画像の横がテープの長さ方向、縦がテープ幅方向です。

- `size: "fit"`（既定）: 画像の高さを印字幅いっぱいに合わせます（縦横比は保持）
- `size: "actual"`: 実寸で印字します。SVG は mm / in の寸法どおり、ラスタ画像は `dpi`（省略時は 1 画素 = 1 ドット）
- ヘッドは 8 ドット/mm で、印字幅は 3.5 / 6 / 9 / 12 / 18 / 24mm テープでそれぞれ 2 / 4 / 7 / 10 / 16 / 18mm です。高さを印字幅にした mm 単位の SVG を `fit` で印刷すると、寸法どおりに印字されます（例: 12mm テープなら高さ 10mm）
- 印刷・確認をしても、アプリで編集中のテキストラベルは変わりません

USB / Bluetooth の接続許可は、最初の 1 回だけアプリの画面で行ってください。中継はローカルサーバー上のアプリだけで有効で、GitHub Pages 版では動きません。

## 注意

カシオ純正のアプリではありません。通信手順は相互運用のために独自に調べたもので、動作は保証されません。
LABEL DESIGN MAKER が起動していると USB / Bluetooth を使えないため、終了してから使ってください。
Bluetooth の機器選択、ローカルフォント、保存先フォルダはブラウザの許可が必要です。
