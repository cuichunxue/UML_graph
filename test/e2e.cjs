/*
 * UML図エディタ E2E回帰テスト
 *
 * 実行:  node test/e2e.cjs
 * 前提:  playwright と Chromium（環境変数 CHROMIUM_PATH で実行ファイルを指定可）
 */
'use strict';
const path = require('path');
const fs = require('fs');

function resolvePlaywright() {
    const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright', '/usr/lib/node_modules/playwright'];
    for (const c of candidates) { try { return require(c); } catch (_) {} }
    console.error('playwright が見つかりません（npm i playwright などで導入してください）');
    process.exit(2);
}
const { chromium } = resolvePlaywright();

const INDEX = 'file://' + path.resolve(__dirname, '..', 'index.html');

(async () => {
    const exe = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
    const browser = await chromium.launch(exe ? { executablePath: exe } : {});
    const page = await (await browser.newContext()).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('PAGEERR: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
    await page.goto(INDEX, { waitUntil: 'load' });
    await page.waitForTimeout(400);
    await page.evaluate(() => { window.confirm = () => true; });

    const results = [];
    const check = (name, cond) => results.push({ name, pass: !!cond });

    /* 1. 全テンプレートが描画・SVG生成できる */
    const tplByType = await page.evaluate(() => {
        const out = {};
        for (const [k, t] of Object.entries(TEMPLATES)) (out[t.type] = out[t.type] || []).push(k);
        return out;
    });
    for (const [type, keys] of Object.entries(tplByType)) {
        for (const key of keys) {
            const r = await page.evaluate(({ type, key }) => {
                switchType(type); loadState(Object.assign({ type }, TEMPLATES[key].make()));
                const items = type === 'sequence' ? (state.participants.length + state.messages.length) : (state.nodes.length + state.edges.length);
                const drawn = document.querySelectorAll('#nodes *, #edges *').length;
                const svg = buildSVG();
                return { items, drawn, svgOk: /<svg/.test(svg) && svg.length > 200 };
            }, { type, key });
            check(`template ${key} (${type}) renders`, r.items > 0 && r.drawn > 0 && r.svgOk);
        }
    }

    /* 2. 全5図種の DSL 往復 */
    const dslChecks = await page.evaluate(() => {
        const out = {};
        switchType('class'); loadState(Object.assign({ type: 'class' }, TEMPLATES.c_comp.make()));
        out.class = (n => { const p = parseDSL(toDSL()); return p.nodes.length === n.nodes.filter(x => x.kind !== 'note').length; })(state);
        switchType('sequence'); loadState(Object.assign({ type: 'sequence' }, TEMPLATES.seq_order.make()));
        { const p = parseSeqDSL(toSeqDSL()); out.sequence = p.participants.length === state.participants.length && p.messages.length === state.messages.length && p.fragments.length === state.fragments.length; }
        switchType('state'); loadState(Object.assign({ type: 'state' }, TEMPLATES.s_order.make()));
        { const p = parseStateDSL(toStateDSL()); out.state = p.edges.length === state.edges.length; }
        switchType('usecase'); loadState(Object.assign({ type: 'usecase' }, TEMPLATES.u_ec.make()));
        { const p = parseGraphDSL('usecase', toGraphDSL()); out.usecase = p.nodes.length === state.nodes.filter(x => x.kind !== 'note').length && p.edges.length === state.edges.length; }
        switchType('component'); loadState(Object.assign({ type: 'component' }, TEMPLATES.comp_web.make()));
        { const p = parseGraphDSL('component', toGraphDSL()); out.component = p.nodes.length === state.nodes.filter(x => x.kind !== 'note').length && p.edges.length === state.edges.length; }
        return out;
    });
    for (const [t, ok] of Object.entries(dslChecks)) check(`DSL round-trip: ${t}`, ok);

    /* 3. 基本編集操作 */
    const ops = await page.evaluate(() => {
        switchType('class'); loadState({ type: 'class', nodes: [], edges: [] });
        createNode('class', 200, 200); const a = state.nodes[0].id;
        createNode('class', 500, 200); const b = state.nodes[1].id;
        createEdge(a, b, 'inheritance');
        const afterCreate = { nodes: state.nodes.length, edges: state.edges.length };
        selNodes = new Set([a, b]); selection = { kind: 'node', id: a }; align('top');
        const aligned = nodeById(a).y === nodeById(b).y;
        selNodes = new Set([a, b]); duplicateSelection();
        const afterDup = state.nodes.length;
        undo(); const afterUndo = state.nodes.length;
        select('edge', state.edges[0].id); deleteSelection();
        return { afterCreate, aligned, afterDup, afterUndo, afterDelEdge: state.edges.length };
    });
    check('create 2 nodes + 1 edge', ops.afterCreate.nodes === 2 && ops.afterCreate.edges === 1);
    check('align top', ops.aligned);
    check('duplicate (2->4)', ops.afterDup === 4);
    check('undo restores (4->2)', ops.afterUndo === 2);
    check('delete edge', ops.afterDelEdge === 0);

    /* 4. ノート＋アンカー線 */
    const notes = await page.evaluate(() => {
        switchType('class'); loadState({ type: 'class', nodes: [{ id: 'n1', kind: 'class', x: 100, y: 100, name: 'A', attributes: [], methods: [] }], edges: [] });
        createNode('note', 350, 120); const note = state.nodes.find(n => n.kind === 'note');
        note.anchor = 'n1'; render();
        return { anchorLines: document.querySelectorAll('.note-anchor').length };
    });
    check('note anchor line drawn', notes.anchorLines === 1);

    /* 5. シーケンス: activation / フラグメント / 自己メッセージ */
    const seq = await page.evaluate(() => {
        switchType('sequence'); loadState(Object.assign({ type: 'sequence' }, TEMPLATES.seq_login.make()));
        const acts = document.querySelectorAll('.seq-activation').length;
        addFragment(); const frags = document.querySelectorAll('.frag-rect').length;
        const p = state.participants[0].id; addMessage(p, p, 'sync'); render();
        return { acts, frags, self: state.messages.some(m => m.from === m.to) };
    });
    check('sequence activations auto', seq.acts > 0);
    check('sequence fragment add', seq.frags === 1);
    check('sequence self message', seq.self);

    /* 6. 自己ループ */
    const selfloop = await page.evaluate(() => {
        switchType('state'); applyStateParsed(parseStateDSL('@startuml\nA --> A : retry\n@enduml'));
        return { edges: document.querySelectorAll('#edges .edge').length, isSelf: state.edges[0].from === state.edges[0].to };
    });
    check('self-loop renders', selfloop.edges === 1 && selfloop.isSelf);

    /* 7. ページの永続化 */
    const persist = await page.evaluate(() => {
        loadState(Object.assign({ type: 'class' }, TEMPLATES.c_inherit.make()));
        addPage('sequence'); loadState(Object.assign({ type: 'sequence' }, TEMPLATES.seq_order.make()));
        const p = JSON.parse(localStorage.getItem('uml_class_editor_v1'));
        return { pages: p.pages.length, hasClass: p.pages.some(x => x.type === 'class' && x.diagram.nodes.length > 0), hasSeq: p.pages.some(x => x.type === 'sequence' && x.diagram.messages.length > 0) };
    });
    check('project persists pages', persist.pages >= 2 && persist.hasClass && persist.hasSeq);

    /* 8. 共有リンク encode/decode */
    const share = await page.evaluate(() => {
        switchType('class'); loadState(Object.assign({ type: 'class' }, TEMPLATES.c_mvc.make()));
        const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(Object.assign({ type: diagramType() }, state)))));
        const decoded = JSON.parse(decodeURIComponent(escape(atob(b64))));
        return { type: decoded.type, nodes: decoded.nodes.length };
    });
    check('share link encode/decode', share.type === 'class' && share.nodes === 3);

    /* 9. PNG 出力 */
    const png = await page.evaluate(async () => {
        switchType('class'); loadState(Object.assign({ type: 'class' }, TEMPLATES.c_inherit.make()));
        try { const blob = await svgToPng(2); return blob && blob.size > 0 && blob.type === 'image/png'; } catch (e) { return false; }
    });
    check('PNG export blob', png);

    /* 10. テーマ切替 */
    const theme = await page.evaluate(() => {
        const before = document.documentElement.getAttribute('data-theme');
        document.getElementById('themeBtn').click();
        const after = document.documentElement.getAttribute('data-theme');
        document.getElementById('themeBtn').click();
        return before !== after;
    });
    check('theme toggle', theme);

    /* 11. DSL往復でベンド点・ラベル位置を保持（バグ修正回帰） */
    const geom = await page.evaluate(() => {
        switchType('class');
        loadState({ type: 'class', nodes: [
            { id: 'a', kind: 'class', x: 60, y: 60, name: 'A', attributes: [], methods: [] },
            { id: 'b', kind: 'class', x: 400, y: 300, name: 'B', attributes: [], methods: [] }
        ], edges: [{ id: 'e1', from: 'a', to: 'b', type: 'association', label: 'x', waypoints: [{ x: 200, y: 80 }], labelDx: 30, labelDy: -5, fromMult: '', toMult: '' }] });
        applyParsed(parseDSL(toDSL()));
        return { wp: (state.edges[0].waypoints || []).length, dx: state.edges[0].labelDx || 0 };
    });
    check('edge geometry survives DSL edit', geom.wp === 1 && geom.dx === 30);

    /* 12. プロジェクト全体の書き出し/読み込み往復 */
    const proj = await page.evaluate(() => {
        activePage().diagram = state;
        const out = JSON.parse(JSON.stringify({ app: 'uml-editor', version: 2, ortho: !!project.ortho, active: project.active, pages: project.pages }));
        loadProject(out);
        return { roundTrip: project.pages.length === out.pages.length, activeKept: project.active === out.active };
    });
    check('project JSON round-trip', proj.roundTrip && proj.activeKept);

    /* 13. ページ削除 → トーストの「元に戻す」で復活 */
    const delUndo = await page.evaluate(() => {
        addPage('state');
        const victim = project.pages[project.pages.length - 1].id;
        const before = project.pages.length;
        deletePage(victim);
        const afterDel = project.pages.length;
        const btn = [...document.querySelectorAll('.toast button')].pop();
        if (btn) btn.click();
        return { before, afterDel, restored: project.pages.some(p => p.id === victim) };
    });
    check('page delete undo', delUndo.afterDel === delUndo.before - 1 && delUndo.restored);

    /* 14. 旧形式(単一クラス図)からの移行 */
    await page.evaluate(() => {
        localStorage.setItem('uml_class_editor_v1', JSON.stringify({ nodes: [{ id: 'n1', kind: 'class', x: 10, y: 10, name: 'Legacy', attributes: [], methods: [] }], edges: [] }));
    });
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(300);
    const migrated = await page.evaluate(() => ({ type: diagramType(), hasLegacy: state.nodes.some(n => n.name === 'Legacy'), pages: project.pages.length }));
    check('legacy migration', migrated.type === 'class' && migrated.hasLegacy && migrated.pages >= 1);

    /* 15. 共有リンク: リロードしてもページが増えない＋ハッシュ除去 */
    const sharedObj = { type: 'class', nodes: [{ id: 'n1', kind: 'class', x: 10, y: 10, name: 'Shared', attributes: [], methods: [] }], edges: [] };
    const b64 = Buffer.from(unescape(encodeURIComponent(JSON.stringify(sharedObj))), 'binary').toString('base64');
    await page.goto('about:blank');                 // 同一ページのハッシュ遷移だと再読込されないため
    await page.goto(INDEX + '#d=' + b64, { waitUntil: 'load' }); await page.waitForTimeout(400);
    const s1 = await page.evaluate(() => ({ n: project.pages.length, hash: location.hash }));
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(400);
    const s2 = await page.evaluate(() => project.pages.length);
    check('share import once, hash cleared', s1.hash === '' && s1.n === s2);

    /* summary */
    const passed = results.filter(r => r.pass).length, total = results.length;
    console.log(`\n=== ${passed}/${total} PASS ===`);
    results.filter(r => !r.pass).forEach(r => console.log('FAIL: ' + r.name));
    if (errors.length) console.log('errors:', JSON.stringify(errors));
    await browser.close();
    process.exit(passed === total && errors.length === 0 ? 0 : 1);
})();
