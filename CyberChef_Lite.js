// ==UserScript==
// @name         CyberChef Pro
// @namespace    http://tampermonkey.net/
// @version      9.0
// @description  智能多层解码工具 - 简洁模式，支持二次解码
// @author       You
// @match        *://*/*
// @grant        GM_setClipboard
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ==================== 用户配置 ====================
    const CONFIG = {
        triggerOffsetX: 60,
        triggerOffsetY: 40,
        panelOffsetX: 50,
        panelOffsetY: 50,
        defaultCompact: true,
    };

    // ==================== 辅助函数 ====================
    function cleanPrefix(str) {
        return str.replace(/^(⚠️[^\n]*\n─+\n|📋[^\n]*\n─+\n)/g, '');
    }

    function clamp(val, min, max) {
        return Math.max(min, Math.min(max, val));
    }

    // ==================== 核心工具库 ====================
    const Tools = {
        hex: function(str) {
            str = cleanPrefix(str);
            let clean = str.replace(/[\s\r\n]+|0x|\\x/gi, '');
            if (/[^0-9a-fA-F]/.test(clean)) throw new Error("非Hex字符");
            if (clean.length < 2) throw new Error("数据太短");

            const warnings = [];
            if (clean.length % 2 !== 0) {
                clean = clean.slice(0, -1);
                warnings.push("截断1字符");
            }

            const bytes = new Uint8Array(clean.length / 2);
            for (let i = 0; i < clean.length; i += 2) {
                bytes[i / 2] = parseInt(clean.substr(i, 2), 16);
            }

            let skip = 0;
            while (skip < bytes.length && skip < 3 && (bytes[skip] & 0xC0) === 0x80) {
                skip++;
            }
            if (skip > 0) warnings.push("跳过" + skip + "续字节");

            const validBytes = skip > 0 ? bytes.slice(skip) : bytes;
            const result = new TextDecoder('utf-8', { fatal: false }).decode(validBytes);

            if (warnings.length > 0) {
                return "⚠️ " + warnings.join(" | ") + "\n" + "─".repeat(40) + "\n" + result;
            }
            return result;
        },

        url: function(str) {
            str = cleanPrefix(str);
            if (!/%[0-9A-Fa-f]{2}/.test(str)) throw new Error("无URL编码");

            let result = str, prev = '', count = 0;
            while (result !== prev && /%[0-9A-Fa-f]{2}/.test(result) && count < 10) {
                prev = result;
                try { result = decodeURIComponent(result); count++; } catch (e) { break; }
            }
            return result;
        },

        base64: function(str) {
            str = cleanPrefix(str);
            const clean = str.replace(/\s/g, '');
            if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length < 4) {
                throw new Error("非Base64格式");
            }
            try {
                const binary = atob(clean);
                const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
                return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            } catch (e) { throw new Error("Base64解码失败"); }
        },

        psBase64: function(str) {
            str = cleanPrefix(str);
            const clean = str.replace(/\s/g, '');
            if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) throw new Error("非Base64格式");
            try {
                const binary = atob(clean);
                const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
                return new TextDecoder('utf-16le').decode(bytes);
            } catch (e) { throw new Error("PS-B64解码失败"); }
        },

        unicode: function(str) {
            str = cleanPrefix(str);
            if (!/\\u[0-9a-fA-F]{4}/.test(str)) throw new Error("无Unicode编码");
            try {
                return JSON.parse('"' + str + '"');
            } catch (e) {
                return str.replace(/\\u([0-9a-fA-F]{4})/gi, (m, c) => String.fromCharCode(parseInt(c, 16)));
            }
        },

        unescape: function(str) {
            str = cleanPrefix(str);
            const ph = '\x00ESC\x00';
            return str.split('\\\\').join(ph)
                .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
                .replace(/\\"/g, '"').replace(/\\'/g, "'").split(ph).join('\\');
        },

        beautify: function(str) {
            str = cleanPrefix(str);
            try { return JSON.stringify(JSON.parse(str), null, 2); }
            catch (e) { return str.replace(/([{},])/g, '$1\n'); }
        },

        smart: function(str) {
            let result = cleanPrefix(str);
            let prev = '';
            const steps = [];
            let rounds = 15;

            while (result !== prev && rounds-- > 0) {
                prev = result;

                if (/\\u[0-9a-fA-F]{4}/.test(result)) {
                    try {
                        const d = Tools.unicode(result);
                        if (d !== result) { result = d; steps.push('Unicode'); continue; }
                    } catch (e) {}
                }

                if (/%[0-9A-Fa-f]{2}/.test(result)) {
                    try {
                        const d = Tools.url(result);
                        if (d !== result) { result = d; steps.push('URL'); continue; }
                    } catch (e) {}
                }

                const hx = result.replace(/[\s\r\n]/g, '');
                if (/^[0-9a-fA-F]+$/.test(hx) && hx.length >= 6) {
                    try {
                        const d = Tools.hex(result);
                        const c = cleanPrefix(d);
                        if (c && /[\x20-\x7e\u4e00-\u9fff]/.test(c)) {
                            result = c; steps.push('Hex'); continue;
                        }
                    } catch (e) {}
                }

                const b64 = result.replace(/\s/g, '');
                if (/^[A-Za-z0-9+/]+={0,2}$/.test(b64) && b64.length >= 8) {
                    try {
                        const d = Tools.base64(result);
                        if (d && /[\x20-\x7e\u4e00-\u9fff]/.test(d)) {
                            result = d; steps.push('Base64'); continue;
                        }
                    } catch (e) {}
                    try {
                        const d = Tools.psBase64(result);
                        if (d && /[\x20-\x7e\u4e00-\u9fff]/.test(d)) {
                            result = d; steps.push('PS-B64'); continue;
                        }
                    } catch (e) {}
                }
            }

            if (/\\[ntr"']/.test(result)) {
                result = Tools.unescape(result);
                steps.push('反转义');
            }

            if (steps.length > 0) {
                return "📋 " + steps.join(' → ') + "\n" + "─".repeat(40) + "\n" + result;
            }
            return result;
        }
    };

    // ==================== UI构建 ====================
    const host = document.createElement('div');
    host.id = 'cyberchef-pro-host';
    host.style.cssText = 'position:absolute;z-index:2147483647;top:0;left:0;pointer-events:none;';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
        * { box-sizing: border-box; margin: 0; padding: 0; }

        .trigger {
            pointer-events: auto;
            position: fixed;
            width: 44px; height: 44px;
            background: linear-gradient(135deg, #667eea, #764ba2);
            border-radius: 50%;
            color: #fff;
            display: flex; align-items: center; justify-content: center;
            cursor: pointer;
            box-shadow: 0 4px 20px rgba(102,126,234,0.5);
            font-size: 22px;
            transition: transform 0.2s, box-shadow 0.2s;
            z-index: 99999;
            user-select: none;
        }
        .trigger:hover {
            transform: scale(1.15);
            box-shadow: 0 6px 30px rgba(102,126,234,0.7);
        }

        .panel {
            pointer-events: auto;
            position: fixed;
            background: #1a1b26;
            color: #a9b1d6;
            border: 1px solid #414868;
            border-radius: 12px;
            box-shadow: 0 25px 80px rgba(0,0,0,0.7);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            display: flex; flex-direction: column;
            opacity: 0;
            transition: opacity 0.2s;
            overflow: hidden;
        }
        .panel.show { opacity: 1; }
        .panel.compact { width: 520px; height: 320px; min-width: 400px; min-height: 250px; resize: both; }
        .panel.full { width: 620px; height: 480px; min-width: 500px; min-height: 380px; resize: both; }

        .header {
            background: linear-gradient(90deg, #1a1b26, #24283b);
            padding: 10px 14px;
            cursor: move;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #414868;
            border-radius: 12px 12px 0 0;
            flex-shrink: 0;
            user-select: none;
            gap: 10px;
        }
        .header .left { display: flex; align-items: center; gap: 10px; }
        .header .title { font-weight: 600; font-size: 14px; color: #7aa2f7; }
        .header .status {
            font-size: 11px; padding: 3px 8px; border-radius: 4px;
            background: #414868; white-space: nowrap;
        }
        .header .status.ok { background: #9ece6a; color: #1a1b26; }
        .header .status.err { background: #f7768e; color: #1a1b26; }
        .header .right { display: flex; align-items: center; gap: 6px; }
        .header .help {
            font-size: 10px; color: #565f89; max-width: 200px;
            line-height: 1.3; text-align: right;
        }

        .icon-btn {
            width: 28px; height: 28px;
            background: #24283b; border: 1px solid #414868;
            border-radius: 6px; color: #a9b1d6;
            cursor: pointer; font-size: 14px;
            display: flex; align-items: center; justify-content: center;
            transition: all 0.15s;
        }
        .icon-btn:hover { background: #414868; color: #fff; }
        .icon-btn.danger:hover { background: #f7768e; color: #1a1b26; }
        .icon-btn.active { background: #7aa2f7; color: #1a1b26; }

        .body {
            flex: 1;
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            overflow: hidden;
            position: relative;
        }

        .output {
            flex: 1;
            width: 100%;
            background: #13141c;
            color: #c0caf5;
            border: 2px solid #414868;
            padding: 12px;
            resize: none;
            font-size: 13px;
            font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
            line-height: 1.6;
            outline: none;
            white-space: pre-wrap;
            word-break: break-all;
            border-radius: 8px;
            transition: border-color 0.2s;
        }
        .output:focus { border-color: #7aa2f7; }
        .output::selection { background: #7aa2f7; color: #1a1b26; }

        .toolbar {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            align-items: center;
            flex-shrink: 0;
        }
        .toolbar .label {
            font-size: 11px;
            color: #565f89;
            font-weight: 500;
        }

        button {
            background: #24283b;
            color: #a9b1d6;
            border: 1px solid #414868;
            padding: 6px 12px;
            cursor: pointer;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 500;
            transition: all 0.15s;
            white-space: nowrap;
        }
        button:hover { background: #414868; color: #c0caf5; }
        button.active { background: #7aa2f7; color: #1a1b26; border-color: #7aa2f7; }
        button.primary { background: #7aa2f7; color: #1a1b26; border-color: #7aa2f7; }
        button.primary:hover { background: #89b4fa; }
        button.warn { background: #e0af68; color: #1a1b26; }
        button.warn:hover { background: #f0c078; }

        .sep { width: 1px; height: 24px; background: #414868; }

        .footer {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 11px;
            color: #565f89;
            flex-shrink: 0;
            padding-top: 8px;
            border-top: 1px solid #24283b;
        }
        .footer .warn { color: #e0af68; }

        .compact-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-shrink: 0;
        }
        .compact-bar .actions { display: flex; gap: 8px; }

        .selection-popup {
            position: absolute;
            bottom: 70px;
            left: 50%;
            transform: translateX(-50%);
            background: #414868;
            color: #c0caf5;
            padding: 10px 16px;
            border-radius: 8px;
            font-size: 12px;
            display: none;
            align-items: center;
            gap: 12px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.4);
            z-index: 100;
            max-width: 90%;
        }
        .selection-popup.show { display: flex; }
        .selection-popup .text {
            max-width: 200px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: #9ece6a;
            font-family: monospace;
        }
    `;
    shadow.appendChild(style);

    // ==================== 状态变量 ====================
    let selectedText = '';
    let selectedRange = null;
    let triggerEl = null;
    let panelEl = null;
    let isDragging = false;
    let isResizing = false;
    let dragOffsetX = 0, dragOffsetY = 0;
    let isCompactMode = CONFIG.defaultCompact;

    // ==================== 事件监听 ====================
    document.addEventListener('mousedown', function(e) {
        if (triggerEl && !host.contains(e.target)) {
            setTimeout(function() {
                const sel = window.getSelection();
                if (!sel || sel.toString().trim() === '') {
                    if (triggerEl) { triggerEl.remove(); triggerEl = null; }
                }
            }, 100);
        }
    });

    document.addEventListener('mouseup', function(e) {
        if (panelEl) {
            const rect = panelEl.getBoundingClientRect();
            const isNearEdge = (e.clientX > rect.right - 20 && e.clientY > rect.bottom - 20);
            if (isNearEdge) {
                isResizing = true;
                return;
            }
        }

        if (isDragging) { isDragging = false; return; }
        if (isResizing) { isResizing = false; return; }
        if (panelEl && host.contains(e.target)) return;

        setTimeout(function() {
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return;

            const text = sel.toString().trim();
            if (!text) return;

            if (triggerEl) { triggerEl.remove(); triggerEl = null; }

            selectedText = text;
            selectedRange = sel.getRangeAt(0).cloneRange();
            showTrigger(e.clientX, e.clientY);
        }, 30);
    });

    document.addEventListener('mousemove', function(e) {
        if (isDragging && panelEl) {
            let newX = e.clientX - dragOffsetX;
            let newY = e.clientY - dragOffsetY;
            const rect = panelEl.getBoundingClientRect();
            newX = clamp(newX, 0, window.innerWidth - rect.width);
            newY = clamp(newY, 0, window.innerHeight - rect.height);
            panelEl.style.left = newX + 'px';
            panelEl.style.top = newY + 'px';
        }
    });

    // ==================== UI函数 ====================
    function removeUI() {
        if (triggerEl) { triggerEl.remove(); triggerEl = null; }
        if (panelEl) { panelEl.remove(); panelEl = null; }
    }

    function removeTrigger() {
        if (triggerEl) { triggerEl.remove(); triggerEl = null; }
    }

    function showTrigger(x, y) {
        const btnSize = 44;
        let finalX = x + CONFIG.triggerOffsetX;
        let finalY = y + CONFIG.triggerOffsetY;
        finalX = clamp(finalX, 10, window.innerWidth - btnSize - 10);
        finalY = clamp(finalY, 10, window.innerHeight - btnSize - 10);

        triggerEl = document.createElement('div');
        triggerEl.className = 'trigger';
        triggerEl.textContent = '⚡';
        triggerEl.style.left = finalX + 'px';
        triggerEl.style.top = finalY + 'px';

        triggerEl.onclick = function(e) {
            e.stopPropagation();
            const cx = e.clientX, cy = e.clientY;
            removeTrigger();
            showPanel(cx, cy);
        };

        shadow.appendChild(triggerEl);
    }

    function showPanel(mx, my) {
        if (panelEl) { panelEl.remove(); panelEl = null; }

        panelEl = document.createElement('div');
        panelEl.className = 'panel ' + (isCompactMode ? 'compact' : 'full');

        let autoResult;
        try { autoResult = Tools.smart(selectedText); }
        catch (e) { autoResult = selectedText; }

        const isDecoded = autoResult !== selectedText;
        const hexLen = selectedText.replace(/[^0-9a-fA-F]/g, '').length;
        const isOdd = hexLen % 2 !== 0;

        panelEl.innerHTML = `
            <div class="header" id="header">
                <div class="left">
                    <span class="title">🔧 CyberChef</span>
                    <span class="status" id="status">Ready</span>
                </div>
                <div class="right">
                    <span class="help" id="help-text">拖拽标题移动 | 右下角缩放</span>
                    <button class="icon-btn" id="btn-mode" title="切换模式">☰</button>
                    <button class="icon-btn danger" id="btn-close" title="关闭 (ESC)">✕</button>
                </div>
            </div>
            <div class="body">
                <textarea class="output" id="output" spellcheck="false"></textarea>

                <!-- 选中弹窗（仅简洁模式） -->
                <div class="selection-popup" id="selection-popup">
                    <span>选中:</span>
                    <span class="text" id="selection-text"></span>
                    <button class="primary" id="btn-decode-selection">智能解码</button>
                    <button id="btn-cancel-selection">取消</button>
                </div>

                <!-- 简洁模式工具栏 -->
                <div class="compact-bar" id="compact-bar">
                    <div class="actions">
                        <button data-tool="smart" class="primary">🔮 智能解码</button>
                        <button id="btn-copy-c">📋 复制</button>
                        <button id="btn-replace-c" class="primary">替换原文</button>
                    </div>
                    <span style="font-size:11px;color:#565f89;">选中部分可单独解码</span>
                </div>

                <!-- 完整模式工具栏 -->
                <div class="toolbar" id="toolbar-decode" style="display:none;">
                    <span class="label">解码</span>
                    <button data-tool="smart" class="primary">🔮 智能</button>
                    <button data-tool="url">URL</button>
                    <button data-tool="hex">Hex</button>
                    <button data-tool="base64">Base64</button>
                    <button data-tool="psBase64">PS-B64</button>
                    <button data-tool="unicode">Unicode</button>
                </div>
                <div class="toolbar" id="toolbar-action" style="display:none;">
                    <span class="label">处理</span>
                    <button data-tool="unescape" class="warn">反转义\\n</button>
                    <button data-tool="beautify">✨美化</button>
                    <span class="sep"></span>
                    <button id="btn-copy">📋 复制</button>
                    <button id="btn-replace" class="primary">替换原文</button>
                </div>
                <div class="footer" id="footer" style="display:none;">
                    <span>
                        原文 ${selectedText.length} 字符
                        ${hexLen > 0 ? ' | Hex ' + hexLen + ' ' + (isOdd ? '<span class="warn">⚠️奇数</span>' : '✓偶数') : ''}
                    </span>
                    <span>选中文本可手动解码</span>
                </div>
            </div>
        `;

        shadow.appendChild(panelEl);

        const outputEl = shadow.getElementById('output');
        const statusEl = shadow.getElementById('status');
        const helpText = shadow.getElementById('help-text');
        const selectionPopup = shadow.getElementById('selection-popup');
        const selectionText = shadow.getElementById('selection-text');
        const compactBar = shadow.getElementById('compact-bar');
        const toolbarDecode = shadow.getElementById('toolbar-decode');
        const toolbarAction = shadow.getElementById('toolbar-action');
        const footerEl = shadow.getElementById('footer');

        outputEl.value = autoResult;
        if (isDecoded) {
            setStatus('✓ 已自动解码', 'ok');
        }

        function updateModeDisplay() {
            if (isCompactMode) {
                panelEl.className = 'panel compact show';
                compactBar.style.display = 'flex';
                toolbarDecode.style.display = 'none';
                toolbarAction.style.display = 'none';
                footerEl.style.display = 'none';
                helpText.textContent = '拖拽标题移动 | 右下角缩放';
            } else {
                panelEl.className = 'panel full show';
                compactBar.style.display = 'none';
                toolbarDecode.style.display = 'flex';
                toolbarAction.style.display = 'flex';
                footerEl.style.display = 'flex';
                helpText.textContent = '拖拽移动 | 右下角缩放';
                // 完整模式下隐藏选中弹窗
                selectionPopup.classList.remove('show');
            }
        }
        updateModeDisplay();

        let px = mx + CONFIG.panelOffsetX;
        let py = my + CONFIG.panelOffsetY;
        const panelW = isCompactMode ? 520 : 620;
        const panelH = isCompactMode ? 320 : 480;
        px = clamp(px, 10, window.innerWidth - panelW - 10);
        py = clamp(py, 10, window.innerHeight - panelH - 10);
        panelEl.style.left = px + 'px';
        panelEl.style.top = py + 'px';

        requestAnimationFrame(function() { panelEl.classList.add('show'); });

        // ========== 事件绑定 ==========

        // 拖拽
        shadow.getElementById('header').onmousedown = function(e) {
            if (e.target.tagName === 'BUTTON') return;
            isDragging = true;
            const rect = panelEl.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            e.preventDefault();
        };

        // 模式切换
        shadow.getElementById('btn-mode').onclick = function() {
            isCompactMode = !isCompactMode;
            this.classList.toggle('active', !isCompactMode);
            updateModeDisplay();
        };

        // 关闭
        shadow.getElementById('btn-close').onclick = removeUI;

        // 工具按钮
        panelEl.querySelectorAll('[data-tool]').forEach(function(btn) {
            btn.onclick = function() {
                const tool = btn.dataset.tool;
                if (!Tools[tool]) return;

                try {
                    const start = outputEl.selectionStart;
                    const end = outputEl.selectionEnd;

                    if (start !== end) {
                        // 解码选中部分并替换
                        const before = outputEl.value.substring(0, start);
                        const selected = outputEl.value.substring(start, end);
                        const after = outputEl.value.substring(end);
                        const decoded = Tools[tool](selected);
                        const cleanDecoded = cleanPrefix(decoded);
                        
                        outputEl.value = before + cleanDecoded + after;
                        
                        // 高亮解码后的内容
                        outputEl.focus();
                        outputEl.setSelectionRange(start, start + cleanDecoded.length);
                        
                        setStatus('✓ 选中部分 ' + tool, 'ok');
                        selectionPopup.classList.remove('show');
                    } else {
                        outputEl.value = Tools[tool](outputEl.value);
                        setStatus('✓ ' + tool, 'ok');
                    }

                    panelEl.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                } catch (err) {
                    setStatus('✗ ' + (err.message || '失败'), 'err');
                }
            };
        });

        // textarea选中监听（仅简洁模式显示弹窗）
        outputEl.addEventListener('mouseup', function() {
            if (!isCompactMode) return; // 完整模式不显示弹窗
            
            const start = outputEl.selectionStart;
            const end = outputEl.selectionEnd;

            if (start !== end) {
                const sel = outputEl.value.substring(start, end);
                selectionText.textContent = sel.length > 30 ? sel.substring(0, 30) + '...' : sel;
                selectionPopup.classList.add('show');
            } else {
                selectionPopup.classList.remove('show');
            }
        });

        // 解码选中按钮
        shadow.getElementById('btn-decode-selection').onclick = function() {
            const start = outputEl.selectionStart;
            const end = outputEl.selectionEnd;
            if (start === end) return;

            try {
                const before = outputEl.value.substring(0, start);
                const selected = outputEl.value.substring(start, end);
                const after = outputEl.value.substring(end);
                const decoded = Tools.smart(selected);
                const cleanDecoded = cleanPrefix(decoded);
                
                outputEl.value = before + cleanDecoded + after;
                
                // 高亮解码后的内容
                outputEl.focus();
                outputEl.setSelectionRange(start, start + cleanDecoded.length);
                
                setStatus('✓ 选中部分已解码', 'ok');
                selectionPopup.classList.remove('show');
            } catch (e) {
                setStatus('✗ 解码失败', 'err');
            }
        };

        // 取消选中
        shadow.getElementById('btn-cancel-selection').onclick = function() {
            selectionPopup.classList.remove('show');
            outputEl.setSelectionRange(0, 0);
        };

        // 复制
        function doCopy() {
            const content = cleanPrefix(outputEl.value);
            navigator.clipboard.writeText(content).then(function() {
                setStatus('✓ 已复制', 'ok');
            });
        }
        const copyBtn1 = shadow.getElementById('btn-copy');
        const copyBtn2 = shadow.getElementById('btn-copy-c');
        if (copyBtn1) copyBtn1.onclick = doCopy;
        if (copyBtn2) copyBtn2.onclick = doCopy;

        // 替换原文（保留换行）
        function doReplace() {
            if (!selectedRange) {
                setStatus('✗ 无选区', 'err');
                return;
            }
            try {
                let finalText = cleanPrefix(outputEl.value);
                // 确保反转义
                finalText = Tools.unescape(finalText);

                selectedRange.deleteContents();

                // 查找最近的元素祖先
                let container = selectedRange.commonAncestorContainer;
                while (container && container.nodeType !== 1) {
                    container = container.parentNode;
                }

                // 检查是否是预格式化环境
                let isPreformatted = false;
                if (container) {
                    const nodeName = container.nodeName.toUpperCase();
                    if (['PRE', 'CODE', 'TEXTAREA', 'INPUT'].includes(nodeName)) {
                        isPreformatted = true;
                    } else {
                        try {
                            const style = window.getComputedStyle(container);
                            const ws = style.whiteSpace || '';
                            if (ws.includes('pre') || ws === 'break-spaces') {
                                isPreformatted = true;
                            }
                        } catch (e) {}
                    }
                }

                if (isPreformatted) {
                    // 预格式化环境直接插入文本
                    selectedRange.insertNode(document.createTextNode(finalText));
                } else {
                    // 普通HTML：换行转<br>
                    const frag = document.createDocumentFragment();
                    const lines = finalText.split('\n');
                    
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i]) {
                            frag.appendChild(document.createTextNode(lines[i]));
                        }
                        if (i < lines.length - 1) {
                            frag.appendChild(document.createElement('br'));
                        }
                    }
                    selectedRange.insertNode(frag);
                }

                removeUI();
            } catch (e) {
                setStatus('✗ 替换失败: ' + e.message, 'err');
            }
        }
        const replaceBtn1 = shadow.getElementById('btn-replace');
        const replaceBtn2 = shadow.getElementById('btn-replace-c');
        if (replaceBtn1) replaceBtn1.onclick = doReplace;
        if (replaceBtn2) replaceBtn2.onclick = doReplace;

        // ESC关闭
        function onEscKey(e) {
            if (e.key === 'Escape') {
                removeUI();
                document.removeEventListener('keydown', onEscKey);
            }
        }
        document.addEventListener('keydown', onEscKey);

        function setStatus(text, type) {
            statusEl.textContent = text;
            statusEl.className = 'status ' + type;
        }
    }

})();
