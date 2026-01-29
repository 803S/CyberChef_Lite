// ==UserScript==
// @name         CyberChef Lite (Draggable & Replace)
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  网页划词解码工具。新特性：1.按住标题栏可拖拽 2.支持将结果替换回原文。
// @author       You
// @match        *://*/*
// @grant        GM_setClipboard
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // --- 核心解码逻辑库---
    const Decoders = {
        hex: (str) => {
            const cleanStr = str.replace(/\s+|0x|\\x/gi, '');
            if (cleanStr.length % 2 !== 0) throw new Error("Hex 长度必须为偶数");
            const byteArray = new Uint8Array(cleanStr.length / 2);
            for (let i = 0; i < cleanStr.length; i += 2) {
                byteArray[i / 2] = parseInt(cleanStr.substr(i, 2), 16);
            }
            return new TextDecoder('utf-8').decode(byteArray);
        },
        url: (str) => decodeURIComponent(str),
        base64: (str) => {
            const binaryString = atob(str.trim());
            const bytes = Uint8Array.from(binaryString, c => c.charCodeAt(0));
            return new TextDecoder('utf-8').decode(bytes);
        },
        psBase64: (str) => {
            const binaryString = atob(str.trim());
            const bytes = Uint8Array.from(binaryString, c => c.charCodeAt(0));
            return new TextDecoder('utf-16le').decode(bytes);
        },
        unicode: (str) => {
            if(!str.includes('\\u')) return str;
            return JSON.parse(`"${str}"`);
        },
        smart: (str) => {
            let res = str;
            try { res = decodeURIComponent(res); } catch(e){}
            try {
                const cleanHex = res.replace(/\s+|0x|\\x|%/g, '');
                if(/^[0-9a-fA-F]+$/.test(cleanHex) && cleanHex.length > 4) {
                     res = Decoders.hex(cleanHex);
                }
            } catch(e){}
            return res;
        }
    };

    // --- UI 构建 ---
    const host = document.createElement('div');
    host.style.cssText = 'position: absolute; z-index: 2147483647; top: 0; left: 0; pointer-events: none;';
    document.body.appendChild(host);
    const shadow = host.attachShadow({mode: 'open'});

    const style = document.createElement('style');
    style.textContent = `
        .trigger-btn {
            pointer-events: auto;
            position: absolute;
            width: 30px;
            height: 30px;
            background: #2196F3;
            border-radius: 50%;
            color: white;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            box-shadow: 0 2px 5px rgba(0,0,0,0.3);
            font-size: 14px;
            transition: transform 0.2s;
        }
        .trigger-btn:hover { transform: scale(1.1); }
        
        .panel {
            pointer-events: auto;
            position: fixed;
            width: 420px;
            background: #2b2b2b;
            color: #e0e0e0;
            border: 1px solid #444;
            border-radius: 8px;
            box-shadow: 0 4px 15px rgba(0,0,0,0.6);
            padding: 0; /* padding移到内部元素，为了header贴边 */
            font-family: Consolas, Monaco, monospace;
            display: flex;
            flex-direction: column;
            opacity: 0;
            transition: opacity 0.1s;
        }

        .panel-header {
            background: #333;
            padding: 8px 10px;
            border-bottom: 1px solid #444;
            border-radius: 8px 8px 0 0;
            cursor: move; /* 关键：显示拖动光标 */
            display: flex;
            justify-content: space-between;
            align-items: center;
            user-select: none; /* 防止拖动时选中文字 */
        }
        .panel-header:hover { background: #3a3a3a; }

        .panel-body { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
        
        .result-box {
            width: 100%;
            min-height: 100px;
            max-height: 400px;
            background: #1e1e1e;
            color: #00ff00;
            border: 1px solid #333;
            padding: 5px;
            box-sizing: border-box;
            resize: vertical; /* 允许调整高度 */
            font-size: 12px;
            overflow: auto;
        }

        .btn-group { display: flex; flex-wrap: wrap; gap: 5px; }

        button {
            background: #444;
            color: white;
            border: 1px solid #555;
            padding: 4px 8px;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
        }
        button:hover { background: #555; }
        button.primary { background: #2196F3; border-color: #1976D2; }
        button.special { background: #9C27B0; border-color: #7B1FA2; }
        button.danger { background: #d32f2f; border-color: #b71c1c; }
        button.replace { background: #ff9800; border-color: #f57c00; color: black; font-weight: bold; }

        .status { font-size: 11px; color: #aaa; }
    `;
    shadow.appendChild(style);

    let selectedText = '';
    let selectedRange = null; // 保存选区对象，用于替换
    let triggerBtn = null;
    let panel = null;

    // --- 拖拽相关的全局变量 ---
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    // --- 事件监听 ---
    document.addEventListener('mouseup', (e) => {
        // 如果正在拖拽面板，不要触发选词逻辑
        if (isDragging) {
            isDragging = false;
            return;
        }

        setTimeout(() => {
            const selection = window.getSelection();
            const text = selection.toString().trim();
            
            // 如果点击的是面板内部，不处理
            if (host.contains(e.target)) return;
            
            removeUI();

            if (text.length > 0) {
                selectedText = text;
                if (selection.rangeCount > 0) {
                    selectedRange = selection.getRangeAt(0).cloneRange(); // 克隆选区以备替换使用
                }
                showTrigger(e.pageX, e.pageY + 10);
            }
        }, 10);
    });

    // 全局移动事件（用于拖拽）
    document.addEventListener('mousemove', (e) => {
        if (isDragging && panel) {
            e.preventDefault(); // 防止拖动时选中文本
            panel.style.left = (e.clientX - dragOffsetX) + 'px';
            panel.style.top = (e.clientY - dragOffsetY) + 'px';
        }
    });

    function removeUI() {
        if (triggerBtn) { triggerBtn.remove(); triggerBtn = null; }
        if (panel) { panel.remove(); panel = null; }
    }

    function showTrigger(x, y) {
        triggerBtn = document.createElement('div');
        triggerBtn.className = 'trigger-btn';
        triggerBtn.innerHTML = '⚡️';
        triggerBtn.style.left = x + 'px';
        triggerBtn.style.top = y + 'px';
        
        triggerBtn.onclick = (e) => {
            e.stopPropagation();
            showPanel(e.clientX, e.clientY);
            triggerBtn.remove();
            triggerBtn = null;
        };
        shadow.appendChild(triggerBtn);
    }

    function showPanel(mouseX, mouseY) {
        panel = document.createElement('div');
        panel.className = 'panel';
        
        panel.innerHTML = `
            <div class="panel-header" id="drag-handle">
                <span style="font-weight:bold;">✨ 解码助手 (按住拖动)</span>
                <span class="status" id="status-msg">Len: ${selectedText.length}</span>
            </div>
            <div class="panel-body">
                <textarea class="result-box" id="output-area">${escapeHtml(selectedText)}</textarea>
                <div class="btn-group">
                    <button id="btn-hex">Hex->Str</button>
                    <button id="btn-url">URL Dec</button>
                    <button id="btn-uni">Unicode</button>
                    <button id="btn-b64">Base64</button>
                    <button id="btn-ps" class="special" title="UTF-16LE Decode">PS Base64</button>
                    <button id="btn-smart" class="primary">智能尝试</button>
                </div>
                <div class="btn-group" style="margin-top:5px; border-top:1px solid #444; padding-top:5px;">
                     <button id="btn-replace" class="replace" title="用当前结果替换网页原文">⚠️ 替换原文</button>
                     <button id="btn-copy">复制结果</button>
                     <button id="btn-use-result">👆 套娃(作为输入)</button>
                     <button id="btn-close" class="danger" style="margin-left:auto;">关闭</button>
                </div>
            </div>
        `;

        shadow.appendChild(panel);

        // --- 位置自适应逻辑 ---
        const rect = panel.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        let finalX = mouseX + 10;
        let finalY = mouseY + 10;

        if (finalX + rect.width > viewportWidth) finalX = mouseX - rect.width - 10;
        if (finalY + rect.height > viewportHeight) finalY = mouseY - rect.height - 10;
        if (finalX < 0) finalX = 10;
        if (finalY < 0) finalY = 10;

        panel.style.left = finalX + 'px';
        panel.style.top = finalY + 'px';
        panel.style.opacity = '1';

        bindEvents();
    }

    function bindEvents() {
        const outputArea = shadow.getElementById('output-area');
        const statusMsg = shadow.getElementById('status-msg');
        const dragHandle = shadow.getElementById('drag-handle');
        
        // --- 绑定拖拽逻辑 ---
        dragHandle.onmousedown = (e) => {
            isDragging = true;
            // 计算鼠标点击点相对于面板左上角的偏移
            const rect = panel.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
        };

        const updateOutput = (result, type) => {
            outputArea.value = result;
            statusMsg.textContent = `${type} OK`;
            statusMsg.style.color = '#4caf50';
        };
        const handleError = (err) => {
            statusMsg.textContent = `Error`;
            statusMsg.title = err.message;
            statusMsg.style.color = '#f44336';
        };
        const getCurrentInput = () => outputArea.value;

        // 解码按钮
        shadow.getElementById('btn-hex').onclick = () => { try { updateOutput(Decoders.hex(getCurrentInput()), 'Hex'); } catch(e) { handleError(e); }};
        shadow.getElementById('btn-url').onclick = () => { try { updateOutput(Decoders.url(getCurrentInput()), 'URL'); } catch(e) { handleError(e); }};
        shadow.getElementById('btn-uni').onclick = () => { try { updateOutput(Decoders.unicode(getCurrentInput()), 'Unicode'); } catch(e) { handleError(e); }};
        shadow.getElementById('btn-b64').onclick = () => { try { updateOutput(Decoders.base64(getCurrentInput()), 'Base64'); } catch(e) { handleError(e); }};
        shadow.getElementById('btn-ps').onclick = () => { try { updateOutput(Decoders.psBase64(getCurrentInput()), 'PS B64'); } catch(e) { handleError(e); }};
        shadow.getElementById('btn-smart').onclick = () => { try { updateOutput(Decoders.smart(getCurrentInput()), 'Smart'); } catch(e) { handleError(e); }};

        // 功能按钮
        shadow.getElementById('btn-copy').onclick = () => {
            navigator.clipboard.writeText(outputArea.value);
            statusMsg.textContent = "Copied";
        };
        
        // --- 替换原文逻辑 ---
        shadow.getElementById('btn-replace').onclick = () => {
            const newText = outputArea.value;
            if (!selectedRange) {
                statusMsg.textContent = "无法定位原文";
                return;
            }
            try {
                // 尝试删除原文并插入新文本
                selectedRange.deleteContents();
                selectedRange.insertNode(document.createTextNode(newText));
                
                // 清理选区，视觉反馈
                window.getSelection().removeAllRanges();
                statusMsg.textContent = "替换成功";
                setTimeout(removeUI, 500); // 替换后0.5秒自动关闭面板
            } catch (e) {
                statusMsg.textContent = "替换失败(区域受限)";
                console.error(e);
            }
        };

        shadow.getElementById('btn-use-result').onclick = () => {
             statusMsg.textContent = "Ready for next";
             outputArea.focus();
             outputArea.style.background = '#333';
             setTimeout(()=> outputArea.style.background = '#1e1e1e', 100);
        };
        shadow.getElementById('btn-close').onclick = removeUI;
    }

    function escapeHtml(text) {
        return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
})();
