# NAME LAND i-ma KL-SP100 ラベルアプリ

カシオ ネームランド KL-SP100 を USB でつないで、ブラウザからラベルを作成・印刷する Web アプリです。

**アプリ:** https://pokibon3.github.io/nameland-label/

## 必要なもの

- Chrome または Edge（WebUSB を使うため。Safari・Firefox は非対応）
- USB で接続した KL-SP100

## できること

- テキスト（Mac にインストールされた全フォント対応）、QR コード、バーコード（CODE128 / JAN・EAN-13 / EAN-8）
- 枠、記号・絵文字、白黒反転
- テープ幅 3.5〜24mm、装着テープ幅の読み取り
- ラベルの保存・呼び出し（任意のフォルダに JSON ファイルとして保存）
- インストールしてアプリとして使用（オフライン起動可）

## ローカルで動かす

```sh
webapp/serve.sh
```

`http://localhost:8123` を Chrome で開きます。

## 注意

カシオ純正のアプリではありません。通信手順は相互運用のために独自に調べたもので、動作は保証されません。
LABEL DESIGN MAKER が起動していると USB を使えないため、終了してから使ってください。
