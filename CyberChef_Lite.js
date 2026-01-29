// ==UserScript==
// @name         CyberChef Pro (Auto-Decode & Beautify)
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  高级网络安全解码工具。支持自动探测编码、JS/JSON美化、自由缩放、智能替换。
// @author       You
// @match        *://*/*
// @grant        GM_setClipboard
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // --- 1. 核心解码与格式化库 ---
    const Tools = {
        // Hex
        hex: (str) => {
            const cleanStr = str.replace(/\s+|0x|\\x/gi, '');
            if (cleanStr.length % 2 !== 0) throw new Error("Hex长度需为偶数");
            if (/[^0-9a-fA-F]/.test(cleanStr)) throw new Error("非Hex字符");
            const byteArray = new Uint8Array(cleanStr.length / 2);
            for (let i = 0; i < cleanStr.length; i += 2) {
                byteArray[i / 2] = parseInt(cleanStr.substr(i, 2), 16);
            }
            return new TextDecoder('utf-8').decode(byteArray);
        },
        // URL
        url: (str) => {
            if (!/%/.test(str)) throw new Error("无URL编码特征");
            return decodeURIComponent(str);
        },
        // Base64
        base64: (str) => {
            // 简单的正则检查，避免把普通英文当B64解
            if (!/^[A-Za-z0-9+/=]+$/.test(str.trim()) || str.length % 4 !== 0) throw new Error("非标准Base64");
            const binaryString = atob(str.trim());
            const bytes = Uint8Array.from(binaryString, c => c.charCodeAt(0));
            return new TextDecoder('utf-8').decode(bytes);
        },
        // PowerShell Base64
        psBase64: (str) => {
            const binaryString = atob(str.trim());
            const bytes = Uint8Array.from(binaryString, c => c.charCodeAt(0));
            return new TextDecoder('utf-16le').decode(bytes);
        },
        // Unicode
        unicode: (str) => {
            if(!str.includes('\\u')) throw new Error("无Unicode特征");
            return JSON.parse(`"${str}"`);
        },
        // JS/JSON 美化 (简易版，不依赖庞大的库)
        beautify: (str) => {
            try {
                // 尝试作为JSON格式化
                const obj = JSON.parse(str);
                return JSON.stringify(obj, null, 4);
            } catch (e) {
                // 简单的 JS/通用代码 格式化 (缩进处理)
                let res = '';
                let indent = 0;
                const clean = str.replace(/\s+/g, ' '); // 压缩空白
                for (let i = 0; i < clean.length; i++) {
                    const char = clean[i];
                    if (char === '{' || char === '[') {
                        res += char + '\n' + '    '.repeat(++indent);
                    } else if (char === '}' || char === ']') {
                        res += '\n' + '    '.repeat(--indent) + char;
                    } else if (char === ',') {
                        res += char + '\n' + '    '.repeat(indent);
                    } else if (char === ';') {
                         res += char + '\n' + '    '.repeat(indent);
                    } else {
                        res += char;
                    }
                }
                return res;
            }
        }
    };

    // --- 2. UI 样式 (Shadow DOM) ---
    const host = document.createElement('div');
    host.style.cssText = 'position: absolute; z-index: 2147483647; top: 0; left: 0; pointer-events: none;';
    document.body.appendChild(host);
    const shadow = host.attachShadow({mode: 'open'});

    const style = document.createElement('style');
    style.textContent = `
        /* 触发按钮 */
        .trigger-btn {
            pointer-events: auto;
            position: absolute;
            width: 32px;
            height: 32px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 50%;
            color: white;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            font-size: 16px;
            transition: transform 0.2s, box-shadow 0.2s;
            z-index: 10000;
        }
        .trigger-btn:hover { transform: scale(1.15); box-shadow: 0 6px 8px rgba(0,0,0,0.4); }

        /* 主面板 */
        .panel {
            pointer-events: auto;
            position: fixed;
            width: 500px;
            height: 350px;
            /* 关键：允许调整大小 */
            resize: both;
            overflow: hidden; 
            min-width: 350px;
            min-height: 250px;
            
            background: rgba(30, 30, 30, 0.95);
            backdrop-filter: blur(10px);
            color: #f0f0f0;
            border: 1px solid #444;
            border-radius: 8px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.7);
            font-family: 'Segoe UI', Consolas, monospace;
            display: flex;
            flex-direction: column;
            opacity: 0;
            transition: opacity 0.15s ease-out;
        }

        /* 标题栏 */
        .panel-header {
            background: #252526;
            padding: 8px 12px;
            border-bottom: 1px solid #3e3e42;
            cursor: move;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 13px;
            font-weight: 600;
            letter-spacing: 0.5px;
            flex-shrink: 0;
        }
        .panel-header:hover { background: #2d2d30; }

        /* 内容区 */
        .panel-body {
            flex: 1;
            padding: 10px;
            display: flex;
            flex-direction: column;
            gap: 10px;
            overflow: hidden;
        }

        /* 文本域 */
        .result-box {
            flex: 1; /* 自动撑满剩余高度 */
            width: 100%;
            background: #1e1e1e;
            color: #dcdcaa;
            border: 1px solid #3e3e42;
            padding: 8px;
            box-sizing: border-box;
            resize: none; /* 由面板整体resize控制 */
            font-size: 13px;
            font-family: Consolas, 'Courier New', monospace;
            outline: none;
            line-height: 1.4;
        }
        .result-box:focus { border-color: #007acc; }

        /* 按钮组 */
        .btn-group {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            flex-shrink: 0;
        }

        /* 按钮样式 */
        button {
            background: #3c3c3c;
            color: #cccccc;
            border: 1px solid #3c3c3c;
            padding: 5px 10px;
            cursor: pointer;
            border-radius: 3px;
            font-size: 12px;
            transition: all 0.1s;
        }
        button:hover { background: #4a4a4a; color: white; }
        
        /* 激活状态 */
        button.active { background: #0e639c; color: white; border-color: #0e639c; font-weight: bold;}
        
        /* 特殊按钮颜色 */
        button.action-btn { background: #2d2d30; border-color: #555; }
        button.replace { background: #ce723b; color: white; }
        button.replace:hover { background: #e08855; }
        button.close { background: #c53030; color: white; }
        button.close:hover { background: #e53e3e; }

        /* 底部状态 */
        .status-bar {
            font-size: 11px;
            color: #858585;
            display: flex;
            justify-content: space-between;
            margin-top: 4px;
        }
    `;
    shadow.appendChild(style);

    // --- 3. 全局变量 ---
    let selectedText = '';
    let selectedRange = null;
    let triggerBtn = null;
    let panel = null;
    
    let isDragging = false;
    let dragOffsetX = 0, dragOffsetY = 0;

    // --- 4. 自动探测逻辑 ---
    function autoDetect(text) {
        text = text.trim();
        // 1. 优先尝试 Unicode (特征明显)
        if (text.includes('\\u')) {
            try { return { type: 'unicode', res: Tools.unicode(text) }; } catch(e){}
        }
        // 2. URL 解码 (如果包含%且解码后变短)
        if (text.includes('%')) {
            try {
                const res = Tools.url(text);
                if (res !== text) return { type: 'url', res: res };
            } catch(e){}
        }
        // 3. Hex 检测 (只有0-9A-F)
        if (/^[0-9a-fA-F\s]+$/.test(text) && text.replace(/\s/g,'').length > 4) {
             try { return { type: 'hex', res: Tools.hex(text) }; } catch(e){}
        }
        // 4. Base64 (最后尝试，因为容易误判)
        // 只有当看起来像乱码或者符合Base64特征时才试
        if (/^[A-Za-z0-9+/=]+$/.test(text) && text.length > 8) {
             try { return { type: 'base64', res: Tools.base64(text) }; } catch(e){}
        }
        
        // 默认返回原文
        return { type: 'raw', res: text };
    }

    // --- 5. 事件监听 ---
    document.addEventListener('mouseup', (e) => {
        if (isDragging) { isDragging = false; return; } // 拖拽结束不触发

        // 延时等待选区稳定
        setTimeout(() => {
            const selection = window.getSelection();
            if (selection.rangeCount === 0) return;
            
            const text = selection.toString().trim();
            if (host.contains(e.target)) return; // 点击面板内部忽略

            removeUI();

            if (text.length > 0) {
                selectedText = text;
                selectedRange = selection.getRangeAt(0).cloneRange();
                showTrigger(e.pageX, e.pageY);
            }
        }, 10);
    });

    // 拖拽移动
    document.addEventListener('mousemove', (e) => {
        if (isDragging && panel) {
            e.preventDefault();
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
        // 初始位置在选区附近
        triggerBtn.style.left = (x + 10) + 'px';
        triggerBtn.style.top = (y + 10) + 'px';
        
        triggerBtn.onmousedown = (e) => e.stopPropagation(); // 防止触发拖拽
        triggerBtn.onclick = (e) => {
            e.stopPropagation();
            showPanel(e.clientX, e.clientY);
            triggerBtn.remove();
            triggerBtn = null;
        };
        shadow.appendChild(triggerBtn);
    }

    // --- 6. 构建主面板 ---
    function showPanel(mouseX, mouseY) {
        panel = document.createElement('div');
        panel.className = 'panel';
        
        // 自动探测
        const autoResult = autoDetect(selectedText);
        const initialContent = autoResult.type === 'raw' ? selectedText : autoResult.res;
        
        panel.innerHTML = `
            <div class="panel-header" id="drag-handle">
                <span>CyberChef Pro</span>
                <span style="font-weight:normal; opacity:0.7">按住拖动 | 右下角缩放</span>
            </div>
            <div class="panel-body">
                <textarea class="result-box" id="output-area" spellcheck="false"></textarea>
                
                <!-- 解码器按钮区 -->
                <div class="btn-group" id="decoder-group">
                    <button data-type="hex" id="btn-hex">Hex</button>
                    <button data-type="url" id="btn-url">URL</button>
                    <button data-type="base64" id="btn-b64">Base64</button>
                    <button data-type="psBase64" id="btn-ps" style="border-color:#9C27B0">PS-B64</button>
                    <button data-type="unicode" id="btn-uni">Unicode</button>
                    <!-- 格式化功能 -->
                    <button id="btn-fmt" class="action-btn" title="格式化JS或JSON">✨ JS美化</button>
                </div>

                <!-- 操作按钮区 -->
                <div class="status-bar">
                    <div class="btn-group">
                         <button id="btn-replace" class="replace">替换原文</button>
                         <button id="btn-copy" class="action-btn">复制</button>
                    </div>
                    <div style="display:flex; gap:5px; align-items:center">
                        <span id="status-text">Ready</span>
                        <button id="btn-close" class="close">×</button>
                    </div>
                </div>
            </div>
        `;

        shadow.appendChild(panel);
        
        const outputArea = shadow.getElementById('output-area');
        outputArea.value = initialContent; // 设置内容

        // 高亮自动探测到的类型
        if(autoResult.type !== 'raw') {
            const btn = shadow.querySelector(`button[data-type="${autoResult.type}"]`);
            if(btn) btn.classList.add('active');
            shadow.getElementById('status-text').textContent = `Auto: ${autoResult.type}`;
        }

        // --- 智能定位 (防止出屏) ---
        const rect = panel.getBoundingClientRect();
        let finalX = mouseX + 20;
        let finalY = mouseY + 20;
        
        if (finalX + rect.width > window.innerWidth) finalX = mouseX - rect.width - 10;
        if (finalY + rect.height > window.innerHeight) finalY = mouseY - rect.height - 10;
        if (finalX < 0) finalX = 10;
        if (finalY < 0) finalY = 10;

        panel.style.left = finalX + 'px';
        panel.style.top = finalY + 'px';
        requestAnimationFrame(() => panel.style.opacity = '1');

        bindPanelEvents(outputArea, autoResult.type);
    }

    // --- 7. 面板交互逻辑 ---
    function bindPanelEvents(textarea, currentType) {
        const status = shadow.getElementById('status-text');
        const dragHandle = shadow.getElementById('drag-handle');
        const decoderGroup = shadow.getElementById('decoder-group');

        // 拖拽逻辑
        dragHandle.onmousedown = (e) => {
            isDragging = true;
            const rect = panel.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
        };

        // 通用解码处理
        const doDecode = (type) => {
            const input = textarea.value; // 对当前框内内容进行处理（支持连续操作）
            try {
                let res;
                if (Tools[type]) {
                    res = Tools[type](input);
                }
                textarea.value = res;
                status.textContent = `${type} 成功`;
                status.style.color = '#4caf50';
                
                // 按钮高亮切换
                shadow.querySelectorAll('.btn-group button').forEach(b => b.classList.remove('active'));
                const targetBtn = shadow.querySelector(`button[data-type="${type}"]`);
                if(targetBtn) targetBtn.classList.add('active');
                
            } catch (err) {
                status.textContent = "解码失败";
                status.style.color = '#f44336';
                console.error(err);
            }
        };

        // 绑定解码按钮
        decoderGroup.onclick = (e) => {
            const type = e.target.getAttribute('data-type');
            if (type) doDecode(type);
        };

        // 美化按钮
        shadow.getElementById('btn-fmt').onclick = () => {
            const val = textarea.value;
            textarea.value = Tools.beautify(val);
            status.textContent = "已格式化";
        };

        // 复制按钮
        shadow.getElementById('btn-copy').onclick = () => {
            navigator.clipboard.writeText(textarea.value);
            status.textContent = "已复制";
        };

        // 替换原文逻辑 (增强版)
        shadow.getElementById('btn-replace').onclick = () => {
            if (!selectedRange) return;
            let newText = textarea.value;
            
            try {
                // 检查上下文
                const container = selectedRange.commonAncestorContainer;
                const parentElement = container.nodeType === 1 ? container : container.parentElement;
                const tagName = parentElement ? parentElement.tagName.toLowerCase() : '';

                // 如果是输入框或textarea，直接赋值
                if (tagName === 'textarea' || tagName === 'input') {
                    // 尝试用 execCommand 保持撤销记录，如果不行则直接改 value
                    if (!document.execCommand('insertText', false, newText)) {
                        parentElement.value = newText;
                    }
                } 
                // 如果是普通网页元素
                else {
                    // 检查是否在代码块 (<pre>, <code>) 中，如果是，保留 \n
                    const isCodeBlock = parentElement.closest('pre') || parentElement.closest('code');
                    
                    if (!isCodeBlock && newText.includes('\n')) {
                        // 如果不在代码块里，且有换行，转换为 <br>
                        newText = newText.replace(/\n/g, '<br>');
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = newText;
                        
                        selectedRange.deleteContents();
                        selectedRange.insertNode(tempDiv); // 插入带格式的片段
                        
                        // 移除外层的 div wrapper（如果只包含文本节点和br）
                        // 简单处理：保留div wrapper防止破坏文档流，或者使用 DocumentFragment
                    } else {
                        // 纯文本替换
                        selectedRange.deleteContents();
                        selectedRange.insertNode(document.createTextNode(newText));
                    }
                }
                
                removeUI();
            } catch (e) {
                status.textContent = "替换受限";
                console.error(e);
            }
        };

        shadow.getElementById('btn-close').onclick = removeUI;
    }

})();
