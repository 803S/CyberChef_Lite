// ==UserScript==
// @name         sit_CyberChef Pro
// @namespace    http://tampermonkey.net/
// @version      10.0
// @description  智能多层解码工具 - 优化版 (单层RAF + 改进解码逻辑 + 状态管理)
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

    // ==================== 状态管理 ====================
    const AppState = {
        selectedText: '',
        selectedRange: null,
        triggerEl: null,
        panelEl: null,
        isDragging: false,
        isResizing: false,
        dragOffsetX: 0,
        dragOffsetY: 0,
        isCompactMode: CONFIG.defaultCompact,
        escListener: null,
        showingSource: false,
        originalText: '',
        lastSelection: '',
        mouseDownX: 0,
        mouseDownY: 0,
    };

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
            const clean = str.replace(/[^A-Za-z0-9+/=]/g, '');

            let padded = clean;
            const mod = clean.length % 4;
            if (mod === 2) padded += '==';
            else if (mod === 3) padded += '=';

            if (padded.length < 4) throw new Error("非Base64格式");

            try {
                const binary = atob(padded);
                const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
                return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            } catch (e) { throw new Error("Base64解码失败"); }
        },

        psBase64: function(str) {
            str = cleanPrefix(str);
            const clean = str.replace(/[^A-Za-z0-9+/=]/g, '');

            let padded = clean;
            const mod = clean.length % 4;
            if (mod === 2) padded += '==';
            else if (mod === 3) padded += '=';
            else if (mod === 1) {
                throw new Error("Base64长度错误（模4余1），请检查选区是否包含多余字符或缺少字符");
            }

            if (padded.length < 4) throw new Error("非Base64格式");

            try {
                const binary = atob(padded);
                const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));

                let offset = 0;
                if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
                    offset = 2;
                }

                let validBytes = bytes.slice(offset);
                if (validBytes.length % 2 !== 0) {
                    validBytes = validBytes.slice(0, -1);
                }

                return new TextDecoder('utf-16le', { fatal: false }).decode(validBytes);
            } catch (e) {
                throw new Error("PS-B64解码失败: " + e.message);
            }
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

        // ==================== 改进：更聪明的停止条件 ====================
        smart: function(str) {
            let result = cleanPrefix(str);
            let prev = '';
            const steps = [];
            let rounds = 15;

            // 辅助函数：判断是否是有效解码结果
            function isValidDecode(s) {
                if (!s) return false;
                const validChars = (s.match(/[\x20-\x7e\u4e00-\u9fff\s\n\r\t(){}\[\]"':;,.<>\/\\`|@#$%^&*+=~_-]/g) || []).length;
                return validChars / s.length > 0.6;
            }

            // 辅助函数：判断结果是否可能是编码（避免过度解码）
            function couldBeEncoded(s) {
                // 检查是否含有足够的编码模式
                const encodingPatterns = [
                    /%[0-9A-Fa-f]{2}/,      // URL编码
                    /\\u[0-9a-fA-F]{4}/,   // Unicode
                    /^[A-Za-z0-9+/=]+$/,   // Base64
                    /^[0-9a-fA-F]+$/,      // Hex
                ];
                const encodedCount = encodingPatterns.filter(p => p.test(s)).length;
                return encodedCount > 0 && s.length > 10;
            }

            // 控制字符比例
            function controlRatio(s) {
                if (!s) return 1;
                const controlChars = (s.match(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g) || []).length;
                return controlChars / s.length;
            }

            while (result !== prev && rounds-- > 0) {
                prev = result;
                let decoded = null;
                let tool = null;

                // 尝试Unicode解码
                if (/\\u[0-9a-fA-F]{4}/.test(result)) {
                    try {
                        const d = Tools.unicode(result);
                        if (d !== result && isValidDecode(d)) { decoded = d; tool = 'Unicode'; }
                    } catch (e) {}
                }

                // 尝试URL解码
                if (!decoded && /%[0-9A-Fa-f]{2}/.test(result)) {
                    try {
                        const d = Tools.url(result);
                        if (d !== result && isValidDecode(d)) { decoded = d; tool = 'URL'; }
                    } catch (e) {}
                }

                // 尝试Hex解码
                if (!decoded) {
                    const hx = result.replace(/[\s\r\n]/g, '');
                    if (/^[0-9a-fA-F]+$/.test(hx) && hx.length >= 6) {
                        try {
                            const d = Tools.hex(result);
                            const c = cleanPrefix(d);
                            if (c && /[\x20-\x7e\u4e00-\u9fff]/.test(c)) {
                                decoded = c; tool = 'Hex';
                            }
                        } catch (e) {}
                    }
                }

                // 尝试Base64解码（增强的智能选择）
                if (!decoded) {
                    const b64 = result.replace(/[^A-Za-z0-9+/=]/g, '');
                    if (/^[A-Za-z0-9+/]+={0,2}$/.test(b64) && b64.length >= 8) {
                        let normalResult = null;
                        let psResult = null;

                        try { normalResult = Tools.base64(result); } catch(e) {}
                        try { psResult = Tools.psBase64(result); } catch(e) {}

                        const normalValid = normalResult && isValidDecode(normalResult);
                        const psValid = psResult && isValidDecode(psResult);

                        if (normalValid || psValid) {
                            const normalNullCount = normalResult ? (normalResult.match(/\x00/g) || []).length : Infinity;
                            const psNullCount = psResult ? (psResult.match(/\x00/g) || []).length : Infinity;
                            const normalCtrlRatio = normalResult ? controlRatio(normalResult) : 1;
                            const psCtrlRatio = psResult ? controlRatio(psResult) : 1;

                            if (normalValid && psValid) {
                                if (normalNullCount === 0 && psNullCount === 0) {
                                    decoded = psCtrlRatio < normalCtrlRatio ? psResult : normalResult;
                                    tool = psCtrlRatio < normalCtrlRatio ? 'PS-B64' : 'Base64';
                                } else if (normalNullCount === 0) {
                                    decoded = normalResult;
                                    tool = 'Base64';
                                } else if (psNullCount === 0) {
                                    decoded = psResult;
                                    tool = 'PS-B64';
                                } else {
                                    decoded = psNullCount < normalNullCount ? psResult : normalResult;
                                    tool = psNullCount < normalNullCount ? 'PS-B64' : 'Base64';
                                }
                            } else if (psValid) {
                                decoded = psResult;
                                tool = 'PS-B64';
                            } else if (normalValid) {
                                decoded = normalResult;
                                tool = 'Base64';
                            }
                        }
                    }
                }

                // 应用解码结果，但检查停止条件
                if (decoded && decoded !== result) {
                    // 新增：如果解码后的文本已经足够清晰且不太可能进一步编码，则停止
                    if (isValidDecode(decoded) && !couldBeEncoded(decoded)) {
                        result = decoded;
                        steps.push(tool);
                        break;  // 提前停止，避免过度解码
                    }
                    result = decoded;
                    steps.push(tool);
                } else {
                    break;  // 无法继续解码
                }
            }

            // 处理反转义
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

    // ==================== 优化：统一处理textarea更新 ====================
    function updateTextareaBatch(textarea, newValue, startPos, endPos, preserveScroll = true) {
        const savedScroll = preserveScroll ? textarea.scrollTop : undefined;

        textarea.value = newValue;
        textarea.setSelectionRange(startPos, endPos);

        if (preserveScroll !== undefined) {
            // 单次RAF即可，避免三层嵌套
            requestAnimationFrame(function() {
                textarea.scrollTop = savedScroll;
            });
        }

        textarea.focus();
    }

    // ==================== UI构建 ====================
    const host = document.createElement('div');
    host.id = 'cyberchef-pro-host';
    host.style.cssText = 'position:absolute;z-index:2147483647;top:0;left:0;pointer-events:none;';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
        :host {
            --color-base-00: rgba(255, 255, 255, 0.85);
            --color-base-01: rgba(248, 250, 255, 0.9);
            --color-base-02: rgba(235, 242, 255, 0.8);
            --color-base-03: rgba(220, 230, 255, 0.7);
            --color-base-04: rgba(180, 200, 230, 0.6);
            --color-base-05: rgba(100, 120, 160, 0.8);
            --color-base-06: rgba(40, 70, 130, 0.95);
            --color-base-07: rgba(20, 40, 90, 1);

            --color-success: #10b981;
            --color-warning: #f59e0b;
            --color-error: #ef4444;
            --color-info: #3b82f6;
            --color-accent: #60a5fa;

            --radius-sm: 4px;
            --radius: 6px;
            --radius-md: 10px;
            --radius-lg: 16px;

            --space-1: 4px;
            --space-2: 8px;
            --space-3: 12px;
            --space-4: 16px;

            --shadow-sm: 0 1px 3px rgba(59, 130, 246, 0.1);
            --shadow-md: 0 4px 12px rgba(59, 130, 246, 0.15);
            --shadow-lg: 0 12px 32px rgba(59, 130, 246, 0.2);
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        .trigger {
            pointer-events: auto;
            position: fixed;
            width: 44px;
            height: 44px;
            background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%);
            border: none;
            border-radius: 50%;
            color: #ffffff;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
            font-weight: 600;
            cursor: pointer;
            box-shadow: 0 8px 24px rgba(59, 130, 246, 0.35), inset 0 1px 0 rgba(255,255,255,0.3);
            z-index: 99999;
            user-select: none;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            backdrop-filter: blur(4px);
        }

        .trigger:hover {
            transform: scale(1.15);
            box-shadow: 0 12px 32px rgba(59, 130, 246, 0.45), inset 0 1px 0 rgba(255,255,255,0.3);
        }

        .trigger:active {
            transform: scale(0.94);
        }

        .panel {
            pointer-events: auto;
            position: fixed;
            background: linear-gradient(135deg, rgba(240, 245, 255, 0.9) 0%, rgba(220, 235, 255, 0.85) 100%);
            color: var(--color-base-06);
            border: 1px solid rgba(180, 200, 230, 0.4);
            border-radius: var(--radius-lg);
            box-shadow: 0 8px 32px rgba(59, 130, 246, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.6);
            backdrop-filter: blur(12px);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            display: flex;
            flex-direction: column;
            opacity: 0;
            transition: opacity 0.2s;
            overflow: hidden;
        }
        .panel.show { opacity: 1; }
        .panel.compact { width: 520px; height: 320px; min-width: 400px; min-height: 250px; resize: both; }
        .panel.full { width: 620px; height: 480px; min-width: 500px; min-height: 380px; resize: both; }

        .header {
            background: linear-gradient(90deg, rgba(230, 240, 255, 0.8) 0%, rgba(210, 230, 255, 0.7) 100%);
            padding: 12px 14px;
            cursor: move;
            display: flex;
            align-items: center;
            gap: 12px;
            border-bottom: 1px solid rgba(180, 200, 230, 0.3);
            flex-shrink: 0;
            user-select: none;
            backdrop-filter: blur(8px);
        }
        .header:dblclick {
            cursor: pointer;
        }
        .header .left {
            display: flex;
            align-items: center;
            gap: 8px;
            flex: 1;
            min-width: 0;
        }
        .header .title {
            font-weight: 600;
            font-size: 14px;
            background: linear-gradient(90deg, #3b82f6 0%, #6366f1 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            letter-spacing: 0.3px;
            white-space: nowrap;
            flex-shrink: 0;
        }
        .header .status {
            font-size: 11px;
            padding: 4px 8px;
            border-radius: var(--radius);
            background: transparent;
            color: rgba(40, 70, 130, 0.9);
            font-weight: 500;
            flex: 1;
            min-width: 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .header .status.ok {
            background: transparent;
            color: var(--color-success);
        }
        .header .status.err {
            background: rgba(239, 68, 68, 0.15);
            color: var(--color-error);
        }
        .header .right {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
            margin-left: auto;
        }
        .header .help {
            font-size: 10px;
            color: var(--color-base-05);
            line-height: 1.4;
            text-align: left;
            flex: 0 1 auto;
            min-width: 50px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .icon-btn {
            width: 32px;
            height: 32px;
            background: rgba(220, 235, 255, 0.5);
            border: 1px solid rgba(180, 200, 230, 0.4);
            border-radius: var(--radius);
            color: var(--color-base-05);
            cursor: pointer;
            font-size: 14px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.15s;
            flex-shrink: 0;
            backdrop-filter: blur(4px);
        }
        .icon-btn:hover {
            background: rgba(200, 220, 255, 0.7);
            border-color: rgba(59, 130, 246, 0.4);
            color: var(--color-base-06);
        }
        .icon-btn:active { transform: scale(0.95); }
        .icon-btn.danger:hover {
            background: rgba(239, 68, 68, 0.1);
            border-color: var(--color-error);
            color: var(--color-error);
        }
        .icon-btn.active {
            background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%);
            border-color: #3b82f6;
            color: #ffffff;
            box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
        }

        .body {
            flex: 1;
            padding: 14px;
            display: flex;
            flex-direction: column;
            gap: 12px;
            overflow: hidden;
            position: relative;
        }

        .output {
            flex: 1;
            width: 100%;
            background: rgba(248, 250, 255, 0.7);
            color: var(--color-base-06);
            border: 1px solid rgba(180, 200, 230, 0.4);
            padding: 12px;
            resize: none;
            font-size: 12px;
            font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
            line-height: 1.6;
            outline: none;
            white-space: pre-wrap;
            word-break: break-all;
            border-radius: var(--radius-md);
            transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
            box-shadow: inset 0 1px 3px rgba(59, 130, 246, 0.08);
            backdrop-filter: blur(4px);
            overflow-y: auto;
            overflow-x: hidden;
        }
        .output:focus {
            border-color: rgba(59, 130, 246, 0.6);
            background: rgba(255, 255, 255, 0.9);
            box-shadow: inset 0 1px 3px rgba(59, 130, 246, 0.08), 0 0 0 3px rgba(59, 130, 246, 0.15);
        }
        .output::selection {
            background: #9ece6a !important;
            color: var(--color-base-06) !important;
        }

        .toolbar {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            align-items: center;
            flex-shrink: 0;
        }
        .toolbar .label {
            font-size: 11px;
            color: var(--color-base-05);
            font-weight: 500;
            letter-spacing: 0.3px;
        }

        button {
            background: rgba(220, 235, 255, 0.5);
            color: var(--color-base-06);
            border: 1px solid rgba(180, 200, 230, 0.4);
            padding: 6px 12px;
            cursor: pointer;
            border-radius: var(--radius);
            font-size: 12px;
            font-weight: 500;
            transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
            white-space: nowrap;
            outline: none;
            backdrop-filter: blur(2px);
        }
        button:hover:not(:disabled) {
            background: rgba(200, 220, 255, 0.7);
            border-color: rgba(59, 130, 246, 0.4);
            color: var(--color-info);
        }
        button:active:not(:disabled) { transform: scale(0.96); }
        button:disabled { opacity: 0.5; cursor: not-allowed; }

        button.active {
            background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%);
            color: #ffffff;
            border-color: #3b82f6;
        }
        button.primary {
            background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%);
            color: #ffffff;
            border-color: #3b82f6;
        }
        button.primary:hover:not(:disabled) {
            background: linear-gradient(135deg, #2563eb 0%, #4f46e5 100%);
            border-color: #2563eb;
            box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
        }
        button.warn {
            background: rgba(245, 158, 11, 0.1);
            color: var(--color-warning);
            border-color: var(--color-warning);
        }
        button.warn:hover:not(:disabled) {
            background: rgba(245, 158, 11, 0.15);
        }

        .sep { width: 1px; height: 24px; background: var(--color-base-03); }

        .footer {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 11px;
            color: var(--color-base-05);
            flex-shrink: 0;
            padding-top: 10px;
            border-top: 1px solid var(--color-base-02);
        }
        .footer .warn { color: var(--color-warning); }

        .compact-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-shrink: 0;
            gap: 12px;
        }
        .compact-bar .actions { display: flex; gap: 6px; flex-wrap: wrap; }

        .selection-popup {
            position: absolute;
            bottom: 70px;
            left: 50%;
            transform: translateX(-50%);
            background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%);
            color: #ffffff;
            padding: 12px 16px;
            border-radius: var(--radius-md);
            border: 1px solid rgba(255,255,255,0.2);
            font-size: 12px;
            display: none;
            align-items: center;
            gap: 12px;
            box-shadow: 0 8px 24px rgba(59, 130, 246, 0.35), inset 0 1px 0 rgba(255,255,255,0.3);
            z-index: 100;
            max-width: 90%;
            font-weight: 500;
            animation: slideDown 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
            backdrop-filter: blur(8px);
        }
        @keyframes slideDown {
            from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
            to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        .selection-popup.show { display: flex; }
        .selection-popup .text {
            max-width: 200px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: #ffffff;
            font-family: 'SF Mono', monospace;
            font-size: 11px;
            font-weight: 400;
            background: rgba(255,255,255,0.2);
            padding: 4px 10px;
            border-radius: 4px;
        }
    `;
    shadow.appendChild(style);

    // ==================== 事件监听 ====================
    document.addEventListener('mousedown', function(e) {
        AppState.mouseDownX = e.clientX;
        AppState.mouseDownY = e.clientY;
        AppState.lastSelection = window.getSelection().toString();

        if (AppState.triggerEl && !host.contains(e.target)) {
            setTimeout(function() {
                const sel = window.getSelection();
                if (!sel || sel.toString().trim() === '') {
                    if (AppState.triggerEl) { AppState.triggerEl.remove(); AppState.triggerEl = null; }
                }
            }, 100);
        }
    });

    document.addEventListener('mouseup', function(e) {
        if (AppState.panelEl) {
            const rect = AppState.panelEl.getBoundingClientRect();
            const isNearEdge = (e.clientX > rect.right - 20 && e.clientY > rect.bottom - 20);
            if (isNearEdge) {
                AppState.isResizing = true;
                return;
            }
        }

        if (AppState.isDragging) { AppState.isDragging = false; return; }
        if (AppState.isResizing) { AppState.isResizing = false; return; }
        if (AppState.panelEl && host.contains(e.target)) return;

        setTimeout(function() {
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return;

            const text = sel.toString().trim();
            if (!text) return;

            if (text === AppState.lastSelection.trim()) return;

            if (AppState.triggerEl) { AppState.triggerEl.remove(); AppState.triggerEl = null; }

            AppState.selectedText = text;
            AppState.originalText = text;
            AppState.selectedRange = sel.getRangeAt(0).cloneRange();
            showTrigger(e.clientX, e.clientY);
        }, 30);
    });

    document.addEventListener('mousemove', function(e) {
        if (AppState.isDragging && AppState.panelEl) {
            let newX = e.clientX - AppState.dragOffsetX;
            let newY = e.clientY - AppState.dragOffsetY;
            const rect = AppState.panelEl.getBoundingClientRect();
            newX = clamp(newX, 0, window.innerWidth - rect.width);
            newY = clamp(newY, 0, window.innerHeight - rect.height);
            AppState.panelEl.style.left = newX + 'px';
            AppState.panelEl.style.top = newY + 'px';
        }
    });

    // ==================== UI函数 ====================
    function removeUI() {
        if (AppState.triggerEl) { AppState.triggerEl.remove(); AppState.triggerEl = null; }
        if (AppState.panelEl) { AppState.panelEl.remove(); AppState.panelEl = null; }
        if (AppState.escListener) {
            document.removeEventListener('keydown', AppState.escListener);
            AppState.escListener = null;
        }
        AppState.showingSource = false;
        AppState.selectedRange = null;
    }

    function removeTrigger() {
        if (AppState.triggerEl) { AppState.triggerEl.remove(); AppState.triggerEl = null; }
    }

    function showTrigger(x, y) {
        const btnSize = 44;
        let finalX = x + CONFIG.triggerOffsetX;
        let finalY = y + CONFIG.triggerOffsetY;
        finalX = clamp(finalX, 10, window.innerWidth - btnSize - 10);
        finalY = clamp(finalY, 10, window.innerHeight - btnSize - 10);

        AppState.triggerEl = document.createElement('div');
        AppState.triggerEl.className = 'trigger';
        AppState.triggerEl.textContent = '⚡';
        AppState.triggerEl.style.left = finalX + 'px';
        AppState.triggerEl.style.top = finalY + 'px';

        AppState.triggerEl.onclick = function(e) {
            e.stopPropagation();
            const cx = e.clientX, cy = e.clientY;
            removeTrigger();
            showPanel(cx, cy);
        };

        shadow.appendChild(AppState.triggerEl);
    }

    function showPanel(mx, my) {
        if (AppState.panelEl) { AppState.panelEl.remove(); AppState.panelEl = null; }

        AppState.panelEl = document.createElement('div');
        AppState.panelEl.className = 'panel ' + (AppState.isCompactMode ? 'compact' : 'full');

        let autoResult;
        try { autoResult = Tools.smart(AppState.selectedText); }
        catch (e) { autoResult = AppState.selectedText; }

        const isDecoded = autoResult !== AppState.selectedText;
        const hexLen = AppState.selectedText.replace(/[^0-9a-fA-F]/g, '').length;
        const isOdd = hexLen % 2 !== 0;

        AppState.panelEl.innerHTML = `
            <div class="header" id="header">
                <div class="left">
                    <span class="title">🔧 CyberChef</span>
                    <span class="status" id="status">Ready</span>
                </div>
                <div class="right">
                    <span class="help" id="help-text">拖拽标题移动 | 右下角缩放 | 双击关闭</span>
                    <button class="icon-btn" id="btn-source" title="查看原文">📄</button>
                    <button class="icon-btn" id="btn-mode" title="切换模式">☰</button>
                    <button class="icon-btn danger" id="btn-close" title="关闭 (ESC)">✕</button>
                </div>
            </div>
            <div class="body">
                <textarea class="output" id="output" spellcheck="false"></textarea>
                <div class="selection-popup" id="selection-popup">
                    <span style="font-size: 11px; color: #ffffff; font-weight: 500;">选中:</span>
                    <span class="text" id="selection-text"></span>
                    <button id="btn-decode-selection" style="padding: 4px 12px; font-size: 11px; background: rgba(255,255,255,0.25); color: #ffffff; border: 1px solid rgba(255,255,255,0.4); font-weight: 500;">🔮 解码</button>
                    <button id="btn-cancel-selection" style="padding: 4px 12px; font-size: 11px; background: transparent; color: #ffffff; border: 1px solid rgba(255,255,255,0.4); font-weight: 500;">取消</button>
                </div>
                <div class="compact-bar" id="compact-bar">
                    <div class="actions">
                        <button data-tool="smart" class="primary">🔮 智能解码</button>
                        <button id="btn-copy-c">📋 复制</button>
                        <button id="btn-replace-c" class="primary">替换原文</button>
                    </div>
                    <span style="font-size: 11px; color: var(--color-base-05);">选中部分可单独解码</span>
                </div>
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
                    <span>原文 ${AppState.selectedText.length} 字符${hexLen > 0 ? ' | Hex ' + hexLen + ' ' + (isOdd ? '<span class="warn">⚠️奇数</span>' : '✓偶数') : ''}</span>
                    <span>选中文本可手动解码</span>
                </div>
            </div>
        `;

        shadow.appendChild(AppState.panelEl);

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
        if (isDecoded) setStatus('✓ 已自动解码', 'ok');

        function updateModeDisplay() {
            if (AppState.isCompactMode) {
                AppState.panelEl.className = 'panel compact show';
                compactBar.style.display = 'flex';
                toolbarDecode.style.display = 'none';
                toolbarAction.style.display = 'none';
                footerEl.style.display = 'none';
                helpText.textContent = '拖拽标题移动 | 右下角缩放';
            } else {
                AppState.panelEl.className = 'panel full show';
                compactBar.style.display = 'none';
                toolbarDecode.style.display = 'flex';
                toolbarAction.style.display = 'flex';
                footerEl.style.display = 'flex';
                helpText.textContent = '拖拽移动 | 右下角缩放';
                selectionPopup.classList.remove('show');
            }
        }
        updateModeDisplay();

        let px = mx + CONFIG.panelOffsetX;
        let py = my + CONFIG.panelOffsetY;
        const panelW = AppState.isCompactMode ? 520 : 620;
        const panelH = AppState.isCompactMode ? 320 : 480;
        px = clamp(px, 10, window.innerWidth - panelW - 10);
        py = clamp(py, 10, window.innerHeight - panelH - 10);
        AppState.panelEl.style.left = px + 'px';
        AppState.panelEl.style.top = py + 'px';

        requestAnimationFrame(function() { AppState.panelEl.classList.add('show'); });

        // ==================== 事件绑定 ====================
        shadow.getElementById('header').onmousedown = function(e) {
            if (e.target.tagName === 'BUTTON') return;
            AppState.isDragging = true;
            const rect = AppState.panelEl.getBoundingClientRect();
            AppState.dragOffsetX = e.clientX - rect.left;
            AppState.dragOffsetY = e.clientY - rect.top;
            e.preventDefault();
        };

        shadow.getElementById('header').ondblclick = function(e) {
            if (e.target.tagName === 'BUTTON') return;
            removeUI();
        };

        const btnSource = shadow.getElementById('btn-source');
        btnSource.onclick = function() {
            AppState.showingSource = !AppState.showingSource;
            if (AppState.showingSource) {
                outputEl.value = AppState.originalText;
                this.classList.add('active');
                setStatus('显示原文', 'ok');
            } else {
                outputEl.value = autoResult;
                this.classList.remove('active');
                setStatus(isDecoded ? '✓ 已自动解码' : 'Ready', isDecoded ? 'ok' : '');
            }
        };

        shadow.getElementById('btn-mode').onclick = function() {
            AppState.isCompactMode = !AppState.isCompactMode;
            this.classList.toggle('active', !AppState.isCompactMode);
            updateModeDisplay();
        };

        shadow.getElementById('btn-close').onclick = removeUI;

        // ==================== 工具按钮事件 ====================
        AppState.panelEl.querySelectorAll('[data-tool]').forEach(function(btn) {
            btn.onclick = function() {
                const tool = btn.dataset.tool;
                if (!Tools[tool]) return;

                try {
                    const start = outputEl.selectionStart;
                    const end = outputEl.selectionEnd;

                    if (start !== end) {
                        // 使用优化后的updateTextareaBatch处理部分解码
                        const before = outputEl.value.substring(0, start);
                        const selected = outputEl.value.substring(start, end);
                        const after = outputEl.value.substring(end);
                        const decoded = Tools[tool](selected);
                        const cleanDecoded = cleanPrefix(decoded);

                        updateTextareaBatch(outputEl, before + cleanDecoded + after, start, start + cleanDecoded.length);
                        setStatus('✓ 选中部分 ' + tool, 'ok');
                        selectionPopup.classList.remove('show');
                    } else {
                        // 完整解码
                        const newValue = Tools[tool](outputEl.value);
                        updateTextareaBatch(outputEl, newValue, 0, newValue.length);
                        setStatus('✓ ' + tool, 'ok');
                    }

                    AppState.panelEl.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                } catch (err) {
                    setStatus('✗ ' + (err.message || '失败'), 'err');
                }
            };
        });

        // textarea选中监听
        outputEl.addEventListener('mouseup', function() {
            if (!AppState.isCompactMode) return;

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

                updateTextareaBatch(outputEl, before + cleanDecoded + after, start, start + cleanDecoded.length);
                setStatus('✓ 选中部分已解码', 'ok');
                selectionPopup.classList.remove('show');
            } catch (e) {
                setStatus('✗ 解码失败', 'err');
            }
        };

        shadow.getElementById('btn-cancel-selection').onclick = function() {
            selectionPopup.classList.remove('show');
            outputEl.setSelectionRange(0, 0);
        };

        // 复制
        function doCopy() {
            let content = cleanPrefix(outputEl.value);
            content = content.replace(/\x00/g, '');

            navigator.clipboard.writeText(content).then(function() {
                setStatus('✓ 已复制', 'ok');
            }).catch(function() {
                if (typeof GM_setClipboard !== 'undefined') {
                    GM_setClipboard(content);
                    setStatus('✓ 已复制 (GM)', 'ok');
                }
            });
        }
        const copyBtn1 = shadow.getElementById('btn-copy');
        const copyBtn2 = shadow.getElementById('btn-copy-c');
        if (copyBtn1) copyBtn1.onclick = doCopy;
        if (copyBtn2) copyBtn2.onclick = doCopy;

        // 替换原文
        function doReplace() {
            if (!AppState.selectedRange) {
                setStatus('✗ 无选区', 'err');
                return;
            }
            try {
                let finalText = cleanPrefix(outputEl.value);
                finalText = Tools.unescape(finalText);
                finalText = finalText.replace(/\x00/g, '');

                AppState.selectedRange.deleteContents();

                let container = AppState.selectedRange.commonAncestorContainer;
                while (container && container.nodeType !== 1) {
                    container = container.parentNode;
                }

                let isPreformatted = false;
                if (container) {
                    const nodeName = container.nodeName.toUpperCase();
                    if (['PRE', 'CODE', 'TEXTAREA'].includes(nodeName)) {
                        isPreformatted = true;
                    } else if (nodeName === 'INPUT') {
                        if (container.value !== undefined) {
                            container.value = finalText;
                            removeUI();
                            return;
                        }
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
                    AppState.selectedRange.insertNode(document.createTextNode(finalText));
                } else {
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
                    AppState.selectedRange.insertNode(frag);
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

        // ESC关闭事件管理
        AppState.escListener = function(e) {
            if (e.key === 'Escape') {
                removeUI();
            }
        };
        document.addEventListener('keydown', AppState.escListener);

        function setStatus(text, type) {
            statusEl.textContent = text;
            statusEl.className = 'status ' + (type || '');
        }
    }

})();
