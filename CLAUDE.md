# UML図エディタ — 開発メモ

単一HTML（`index.html`）・依存ゼロ・完全オフラインのUMLエディタ。
ビルド工程はなく、ブラウザで直接開いて動く。**この制約（単一ファイル・外部依存なし）は本プロジェクトの意図的な設計方針**なので、モジュール分割やバンドラ導入は提案しないこと。

## 実行とテスト

```bash
# アプリ: index.html をブラウザで開くだけ
# テスト（Playwright + Chromium が必要。CHROMIUM_PATH で実行ファイル指定可）
node test/e2e.cjs        # 34項目の回帰テスト。全て PASS が正常
```

コード変更後は必ず `node test/e2e.cjs` を実行すること。
構文チェックだけなら:
```bash
node -e "const m=require('fs').readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/);new Function(m[1])"
```

## アーキテクチャ（index.html 内の1本のスクリプト）

### データモデル
```
project = {
  ortho: bool,                     // 直交配線トグル
  active: pageId,
  pages: [{ id, name, type, diagram }]   // 複数ページ（タブ）
}
```
- `type` ∈ class / state / usecase / component / sequence（定義は `DIAGRAMS`）
- 自由配置4図種の `diagram` = `{ nodes, edges }`
  - node: `{ id, kind, x, y, name, ... }`。`kind` で図形が決まる（class/state/initial/final/actor/usecase/boundary/component/interface/note/package）
  - `node.parent` = 入れ子コンテナ（パッケージ/複合状態/境界）。コンテナ幾何は `layoutContainers()` が子の包含矩形から毎レンダー自動算出
  - edge: `{ id, from, to, type, label, fromMult, toMult, waypoints?, labelDx?, labelDy? }`
- シーケンス図の `diagram` = `{ participants, messages, fragments, notes }`（時間軸ベースの別エンジン `renderSequence()`）
- `state` 変数 = アクティブページの `diagram` への参照。ページ切替は `switchPage()` → `reloadActive()`

### 描画
- `<svg id="canvas">` 内の `#edges` / `#nodes` / `#overlay` レイヤーに毎回 `replaceChildren` で全再描画（`render()`）
- 関連線は `routeEdge()`: 直線 / 直交（Z字ジョグ・`vBlocked/hBlocked` で障害物回避）/ 手動 `waypoints` 経由
- マーカー（矢じり/三角/菱形/ball/socket）は `marker()` が SVG path を生成
- 書き出しは `buildSVG()` がテーマ色を `<style>` に焼き込んだ自己完結SVGを生成 → `svgToPng()` で canvas ラスタライズ（taintしない）

### テキスト双方向同期（PlantUML風DSL）
- 図→テキスト: `toDSL`(class) / `toSeqDSL` / `toStateDSL` / `toGraphDSL`(usecase・component)
- テキスト→図: `parseDSL` / `parseSeqDSL` / `parseStateDSL` / `parseGraphDSL` → 各 `apply*Parsed`
- **位置はノード名で突き合わせて保持**。関連の手動配線（waypoints/labelDx/Dy）は `carryEdgeGeometry()` が「両端名＋種別」で引き継ぐ。ノートはDSL対象外で常に保持
- パッケージ/複合状態/境界は `package X {}` / `state X {}` / `rectangle "X" {}` の入れ子ブロック

### 永続化・共有
- localStorage キー `uml_class_editor_v1` にプロジェクト全体を自動保存。旧形式（単一図 / 5図種固定）は init で自動移行
- 💾 = プロジェクト全体JSON（`{app,version:2,ortho,active,pages}`）。📂 は全形式を判別して読込
- 🔗 共有リンクは**現在ページのみ**を `#d=<base64>` で埋め込み。取り込み後にハッシュを除去（ページ増殖防止）

### 注意点・既知の罠
- グローバルの `let history` は**Undoスタック**で `window.history` を隠蔽している。ブラウザ履歴APIは必ず `window.history.` で呼ぶこと
- `carryEdgeGeometry` のキー区切りは `\u0000` / `\u0001` のエスケープ表記。生の制御文字をファイルに入れないこと
- Undo/Redo はページ内のみ。ページ操作（追加/削除）は対象外（削除はトーストの「元に戻す」で復旧）
- テスト内で `confirm` を伴う操作をするときは `window.confirm = () => true` をスタブすること
