// ==UserScript==
// @name         CyberChef Pro
// @namespace    http://tampermonkey.net/
// @version      7.0
// @description  智能多层解码：自动识别Hex/URL/Base64/Unicode并循环解码
// @author       You
// @match        *://*/*
// @grant        GM_setClipboard
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ==================== 用户配置 ====================
    const CONFIG = {
        triggerOffsetX: 60,     // 触发按钮水平偏移（正=右）
        triggerOffsetY: 40,     // 触发按钮垂直偏移（正=下）
        panelOffsetX: 50,       // 面板水平偏移
        panelOffsetY: 50,       // 面板垂直偏移
    };

    // ==================== 辅助函数 ====================
    // 清理输出中的前缀信息（用于二次解码）
    function cleanPrefix(str) {
        return str.replace(/^(⚠️[^\n]*\n─+\n|📋[^\n]*\n─+\n)/g, '');
    }

    // ==================== 核心工具库 ====================
    const Tools = {

        // Hex解码（智能修复UTF-8边界）
        hex: function(str) {
            str = cleanPrefix(str);
            let clean = str.replace(/[\s\r\n]+|0x|\\x/gi, '');

            if (/[^0-9a-fA-F]/.test(clean)) {
                throw new Error("非Hex字符");
            }
            if (clean.length < 2) {
                throw new Error("数据太短");
            }

            const warnings = [];

            // 奇数长度从结尾截断
            if (clean.length % 2 !== 0) {
                clean = clean.slice(0, -1);
                warnings.push("截断1字符");
            }

            // 转换为字节数组
            const bytes = new Uint8Array(clean.length / 2);
            for (let i = 0; i < clean.length; i += 2) {
                bytes[i / 2] = parseInt(clean.substr(i, 2), 16);
            }

            // 跳过开头的UTF-8续字节(10xxxxxx = 0x80-0xBF)
            let skip = 0;
            while (skip < bytes.length && skip < 3 && (bytes[skip] & 0xC0) === 0x80) {
                skip++;
            }
            if (skip > 0) {
                warnings.push("跳过" + skip + "续字节");
            }

            const validBytes = skip > 0 ? bytes.slice(skip) : bytes;
            const result = new TextDecoder('utf-8', { fatal: false }).decode(validBytes);

            if (warnings.length > 0) {
                return "⚠️ " + warnings.join(" | ") + "\n" + "─".repeat(40) + "\n" + result;
            }
            return result;
        },

        // URL解码（支持多层）
        url: function(str) {
            str = cleanPrefix(str);

            if (!/%[0-9A-Fa-f]{2}/.test(str)) {
                throw new Error("无URL编码");
            }

            let result = str;
            let prev = '';
            let count = 0;

            while (result !== prev && /%[0-9A-Fa-f]{2}/.test(result) && count < 10) {
                prev = result;
                try {
                    result = decodeURIComponent(result);
                    count++;
                } catch (e) {
                    break;
                }
            }
            return result;
        },

        // Base64解码
        base64: function(str) {
            str = cleanPrefix(str);
            const clean = str.replace(/\s/g, '');

            if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length < 4) {
                throw new Error("非Base64格式");
            }

            try {
                const binary = atob(clean);
                const bytes = Uint8Array.from(binary, function(c) { return c.charCodeAt(0); });
                return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            } catch (e) {
                throw new Error("Base64解码失败");
            }
        },

        // PowerShell Base64 (UTF-16LE)
        psBase64: function(str) {
            str = cleanPrefix(str);
            const clean = str.replace(/\s/g, '');

            if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
                throw new Error("非Base64格式");
            }

            try {
                const binary = atob(clean);
                const bytes = Uint8Array.from(binary, function(c) { return c.charCodeAt(0); });
                return new TextDecoder('utf-16le').decode(bytes);
            } catch (e) {
                throw new Error("PS-B64解码失败");
            }
        },

        // Unicode解码 (\uXXXX)
        unicode: function(str) {
            str = cleanPrefix(str);

            if (!/\\u[0-9a-fA-F]{4}/.test(str)) {
                throw new Error("无Unicode编码");
            }

            try {
                return JSON.parse('"' + str + '"');
            } catch (e) {
                return str.replace(/\\u([0-9a-fA-F]{4})/gi, function(match, code) {
                    return String.fromCharCode(parseInt(code, 16));
                });
            }
        },

        // 反转义：\n → 换行
        unescape: function(str) {
            str = cleanPrefix(str);
            const placeholder = '\x00ESCAPED\x00';
            return str
                .split('\\\\').join(placeholder)
                .replace(/\\n/g, '\n')
                .replace(/\\t/g, '\t')
                .replace(/\\r/g, '\r')
                .replace(/\\"/g, '"')
                .replace(/\\'/g, "'")
                .split(placeholder).join('\\');
        },

        // JSON美化
        beautify: function(str) {
            str = cleanPrefix(str);
            try {
                return JSON.stringify(JSON.parse(str), null, 2);
            } catch (e) {
                return str
                    .replace(/\{/g, '{\n  ')
                    .replace(/\}/g, '\n}')
                    .replace(/,/g, ',\n  ');
            }
        },

        // ★★★ 智能解码：自动循环解码多层 ★★★
        smart: function(str) {
            let result = cleanPrefix(str);
            let prev = '';
            const steps = [];
            let maxRounds = 15;

            while (result !== prev && maxRounds-- > 0) {
                prev = result;

                // 1. Unicode \uXXXX
                if (/\\u[0-9a-fA-F]{4}/.test(result)) {
                    try {
                        const decoded = Tools.unicode(result);
                        if (decoded !== result) {
                            result = decoded;
                            steps.push('Unicode');
                            continue;
                        }
                    } catch (e) {}
                }

                // 2. URL编码
                if (/%[0-9A-Fa-f]{2}/.test(result)) {
                    try {
                        const decoded = Tools.url(result);
                        if (decoded !== result) {
                            result = decoded;
                            steps.push('URL');
                            continue;
                        }
                    } catch (e) {}
                }

                // 3. 纯Hex（长度足够且全是hex字符）
                const hexClean = result.replace(/[\s\r\n]/g, '');
                if (/^[0-9a-fA-F]+$/.test(hexClean) && hexClean.length >= 6) {
                    try {
                        const decoded = Tools.hex(result);
                        const content = cleanPrefix(decoded);
                        // 检查是否有意义（包含可读字符）
                        if (content && /[\x20-\x7e\u4e00-\u9fff]/.test(content)) {
                            result = content;
                            steps.push('Hex');
                            continue;
                        }
                    } catch (e) {}
                }

                // 4. Base64
                const b64Clean = result.replace(/\s/g, '');
                if (/^[A-Za-z0-9+/]+={0,2}$/.test(b64Clean) && b64Clean.length >= 8) {
                    // 尝试普通Base64
                    try {
                        const decoded = Tools.base64(result);
                        if (decoded && /[\x20-\x7e\u4e00-\u9fff]/.test(decoded)) {
                            result = decoded;
                            steps.push('Base64');
                            continue;
                        }
                    } catch (e) {}

                    // 尝试PS-Base64 (UTF-16LE)
                    try {
                        const decoded = Tools.psBase64(result);
                        if (decoded && /[\x20-\x7e\u4e00-\u9fff]/.test(decoded)) {
                            result = decoded;
                            steps.push('PS-B64');
                            continue;
                        }
                    } catch (e) {}
                }
            }

            // 最后检查是否需要反转义
            if (/\\[ntr"']/.test(result)) {
                result = Tools.unescape(result);
                steps.push('反转义');
            }

            // 返回结果
            if (steps.length > 0) {
                return "📋 " + steps.join(' → ') + "\n" + "─".repeat(40) + "\n" + result;
            }
            return result;
        }
    };

    // ==================== UI 构建 ====================
    const host = document.createElement('div');
    host.id = 'cyberchef-pro';
    host.style.cssText = 'position:absolute;z-index:2147483647;top:0;left:0;pointer-events:none;';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
        * { box-sizing: border-box; margin: 0; padding: 0; }

        .trigger {
            pointer-events: auto;
            position: absolute;
            width: 44px;
            height: 44px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 50%;
            color: #fff;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            box-shadow: 0 4px 20px rgba(102, 126, 234, 0.5);
            font-size: 22px;
            transition: transform 0.2s, box-shadow 0.2s;
            z-index: 99999;
            user-select: none;
        }
        .trigger:hover {
            transform: scale(1.15);
            box-shadow: 0 6px 30px rgba(102, 126, 234, 0.7);
        }

        .panel {
            pointer-events: auto;
            position: fixed;
            width: 620px;
            height: 460px;
            resize: both;
            overflow: hidden;
            min-width: 500px;
            min-height: 350px;
            background: #1a1b26;
            color: #a9b1d6;
            border: 1px solid #414868;
            border-radius: 12px;
            box-shadow: 0 25px 80px rgba(0, 0, 0, 0.7);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            flex-direction: column;
            opacity: 0;
            transition: opacity 0.2s;
        }
        .panel.show { opacity: 1; }

        .header {
            background: linear-gradient(90deg, #1a1b26, #24283b);
            padding: 14px 18px;
            cursor: move;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #414868;
            border-radius: 12px 12px 0 0;
            flex-shrink: 0;
            user-select: none;
        }
        .header .title {
            font-weight: 600;
            font-size: 15px;
            color: #7aa2f7;
        }
        .header .status {
            font-size: 12px;
            padding: 5px 12px;
            border-radius: 6px;
            background: #414868;
            transition: all 0.2s;
        }
        .header .status.ok { background: #9ece6a; color: #1a1b26; }
        .header .status.err { background: #f7768e; color: #1a1b26; }

        .body {
            flex: 1;
            padding: 14px;
            display: flex;
            flex-direction: column;
            gap: 12px;
            overflow: hidden;
        }

        .output {
            flex: 1;
            width: 100%;
            background: #13141c;
            color: #c0caf5;
            border: 2px solid #414868;
            padding: 14px;
            resize: none;
            font-size: 13px;
            font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
            line-height: 1.7;
            outline: none;
            white-space: pre-wrap;
            word-break: break-all;
            border-radius: 8px;
            transition: border-color 0.2s;
        }
        .output:focus { border-color: #7aa2f7; }

        .row {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            align-items: center;
        }
        .row .label {
            font-size: 12px;
            color: #565f89;
            min-width: 45px;
            font-weight: 500;
        }

        button {
            background: #24283b;
            color: #a9b1d6;
            border: 1px solid #414868;
            padding: 7px 14px;
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
        button.warn { background: #e0af68; color: #1a1b26; border-color: #e0af68; }
        button.warn:hover { background: #f0c078; }
        button.danger { background: #f7768e; color: #1a1b26; border-color: #f7768e; }
        button.danger:hover { background: #ff8fa3; }

        .sep { width: 1px; height: 26px; background: #414868; }

        .footer {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding-top: 10px;
            border-top: 1px solid #24283b;
            font-size: 11px;
            color: #565f89;
        }
        .footer .warn { color: #e0af68; font-weight: 600; }
    `;
    shadow.appendChild(style);

    // ==================== 状态变量 ====================
    let selectedText = '';
    let selectedRange = null;
    let triggerEl = null;
    let panelEl = null;
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    // ==================== 事件监听 ====================
    document.addEventListener('mouseup', function(e) {
        if (isDragging) {
            isDragging = false;
            return;
        }

        setTimeout(function() {
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return;

            const text = sel.toString().trim();
            if (host.contains(e.target) || !text) return;

            removeUI();
            selectedText = text;
            selectedRange = sel.getRangeAt(0).cloneRange();
            showTrigger(e.pageX, e.pageY);
        }, 30);
    });

    document.addEventListener('mousemove', function(e) {
        if (isDragging && panelEl) {
            panelEl.style.left = (e.clientX - dragOffsetX) + 'px';
            panelEl.style.top = (e.clientY - dragOffsetY) + 'px';
        }
    });

    document.addEventListener('mouseup', function() {
        isDragging = false;
    });

    // ==================== UI 函数 ====================
    function removeUI() {
        if (triggerEl) {
            triggerEl.remove();
            triggerEl = null;
        }
        if (panelEl) {
            panelEl.remove();
            panelEl = null;
        }
    }

    function showTrigger(x, y) {
        triggerEl = document.createElement('div');
        triggerEl.className = 'trigger';
        triggerEl.textContent = '⚡';
        triggerEl.style.left = (x + CONFIG.triggerOffsetX) + 'px';
        triggerEl.style.top = (y + CONFIG.triggerOffsetY) + 'px';

        triggerEl.onclick = function(e) {
            e.stopPropagation();
            const cx = e.clientX;
            const cy = e.clientY;
            removeUI();
            showPanel(cx, cy);
        };

        shadow.appendChild(triggerEl);
    }

    function showPanel(mx, my) {
        panelEl = document.createElement('div');
        panelEl.className = 'panel';

        // 自动智能解码
        let autoResult;
        try {
            autoResult = Tools.smart(selectedText);
        } catch (e) {
            autoResult = selectedText;
        }

        // 统计信息
        const hexLen = selectedText.replace(/[^0-9a-fA-F]/g, '').length;
        const isOdd = hexLen % 2 !== 0;
        const isDecoded = autoResult !== selectedText;

        panelEl.innerHTML = `
            <div class="header" id="header">
                <span class="title">🔧 CyberChef Pro</span>
                <span class="status" id="status">Ready</span>
            </div>
            <div class="body">
                <textarea class="output" id="output" spellcheck="false"></textarea>

                <div class="row">
                    <span class="label">解码</span>
                    <button data-tool="smart" class="primary">🔮 智能解码</button>
                    <button data-tool="url">URL</button>
                    <button data-tool="hex">Hex</button>
                    <button data-tool="base64">Base64</button>
                    <button data-tool="psBase64">PS-B64</button>
                    <button data-tool="unicode">Unicode</button>
                </div>

                <div class="row">
                    <span class="label">处理</span>
                    <button data-tool="unescape" class="warn">反转义\\n</button>
                    <button data-tool="beautify">✨ 美化</button>
                    <span class="sep"></span>
                    <button id="btn-copy">📋 复制</button>
                    <button id="btn-replace" class="primary">替换原文</button>
                    <button id="btn-close" class="danger">✕</button>
                </div>

                <div class="footer">
                    <span>
                        原文 ${selectedText.length} 字符
                        ${hexLen > 0 ? ' | Hex ' + hexLen + '字符 ' + (isOdd ? '<span class="warn">⚠️奇数</span>' : '✓偶数') : ''}
                    </span>
                </div>
            </div>
        `;

        shadow.appendChild(panelEl);

        const outputEl = shadow.getElementById('output');
        const statusEl = shadow.getElementById('status');

        // 设置初始内容
        outputEl.value = autoResult;
        if (isDecoded) {
            setStatus('✓ 已自动解码', 'ok');
            shadow.querySelector('[data-tool="smart"]').classList.add('active');
        }

        // 定位（确保在屏幕内）
        let px = mx + CONFIG.panelOffsetX;
        let py = my + CONFIG.panelOffsetY;
        px = Math.max(10, Math.min(px, window.innerWidth - 640));
        py = Math.max(10, Math.min(py, window.innerHeight - 480));
        panelEl.style.left = px + 'px';
        panelEl.style.top = py + 'px';

        requestAnimationFrame(function() {
            panelEl.classList.add('show');
        });

        // ========== 事件绑定 ==========

        // 拖拽
        shadow.getElementById('header').onmousedown = function(e) {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SPAN') return;
            isDragging = true;
            const rect = panelEl.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
        };

        // 工具按钮点击
        panelEl.querySelectorAll('[data-tool]').forEach(function(btn) {
            btn.onclick = function() {
                const tool = btn.dataset.tool;
                if (!Tools[tool]) return;

                try {
                    outputEl.value = Tools[tool](outputEl.value);
                    setStatus('✓ ' + tool, 'ok');

                    // 更新按钮状态
                    panelEl.querySelectorAll('[data-tool]').forEach(function(b) {
                        b.classList.remove('active');
                    });
                    btn.classList.add('active');
                } catch (err) {
                    setStatus('✗ ' + (err.message || '失败'), 'err');
                }
            };
        });

        // 复制按钮
        shadow.getElementById('btn-copy').onclick = function() {
            const content = cleanPrefix(outputEl.value);
            navigator.clipboard.writeText(content).then(function() {
                setStatus('✓ 已复制', 'ok');
            });
        };

        // 替换原文按钮
        shadow.getElementById('btn-replace').onclick = function() {
            if (!selectedRange) {
                setStatus('✗ 无选区', 'err');
                return;
            }
            try {
                // 清理前缀并反转义
                let finalText = cleanPrefix(outputEl.value);
                finalText = Tools.unescape(finalText);

                selectedRange.deleteContents();
                selectedRange.insertNode(document.createTextNode(finalText));
                removeUI();
            } catch (e) {
                setStatus('✗ 无法替换', 'err');
            }
        };

        // 关闭按钮
        shadow.getElementById('btn-close').onclick = removeUI;

        // ESC键关闭
        function onEscKey(e) {
            if (e.key === 'Escape') {
                removeUI();
                document.removeEventListener('keydown', onEscKey);
            }
        }
        document.addEventListener('keydown', onEscKey);

        // 状态更新函数
        function setStatus(text, type) {
            statusEl.textContent = text;
            statusEl.className = 'status ' + type;
        }
    }

})();
