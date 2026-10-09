// ==UserScript==
// @name         BiliTK B站工具
// @namespace    https://github.com/SavingPot/BiliTk
// @updateURL    https://raw.githubusercontent.com/SavingPot/BiliTk/main/BiliTk.user.js
// @downloadURL  https://raw.githubusercontent.com/SavingPot/BiliTk/main/BiliTk.user.js
// @version      1.2
// @description  详细介绍见 https://github.com/SavingPot/BiliTk
// @author       SavingPot
// @match        http*://www.bilibili.com/video/*
// @match        http*://www.bilibili.com/bangumi/play/ss*
// @match        http*://www.bilibili.com/bangumi/play/ep*
// @match        https://www.bilibili.com/cheese/play/ss*
// @match        https://www.bilibili.com/cheese/play/ep*
// @match        http*://www.bilibili.com/list/watchlater*
// @match        http*://www.bilibili.com/list/ml*
// @match        https://www.bilibili.com/medialist/play/watchlater/*
// @match        http*://www.bilibili.com/medialist/play/ml*
// @match        http*://www.bilibili.com/blackboard/html5player.html*
// @match        https://chat.deepseek.com/*
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  "use strict";

  // ================================================================
  // DeepSeek 页面侧：接收 B 站传来的字幕并【模拟用户】填入发送
  // ================================================================
  const DS_STORAGE_KEY = "bilitk_deepseek_pending_v1";

  function handleDeepSeekPage() {
    let pending = null;
    try {
      pending =
        typeof GM_getValue === "function"
          ? GM_getValue(DS_STORAGE_KEY, null)
          : null;
    } catch (e) {
      pending = null;
    }
    if (!pending || !pending.text) return;

    // 超过 5 分钟的旧消息忽略，避免重复发送
    if (pending.ts && Date.now() - pending.ts > 5 * 60 * 1000) {
      try {
        GM_deleteValue(DS_STORAGE_KEY);
      } catch (e) {}
      return;
    }

    let done = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 60; // 约 30 秒
    let timer = null;

    const cleanup = () => {
      done = true;
      if (timer) clearInterval(timer);
      try {
        GM_deleteValue(DS_STORAGE_KEY);
      } catch (e) {}
    };

    const findInput = () =>
      document.querySelector("textarea#chat-input") ||
      document.querySelector('textarea[placeholder*="DeepSeek"]') ||
      document.querySelector('textarea[placeholder*="发送"]') ||
      document.querySelector('textarea[placeholder*="输入"]') ||
      document.querySelector("textarea") ||
      document.querySelector('[contenteditable="true"]');

    const findSendButton = (input) => {
      let node = input.parentElement;
      for (let depth = 0; depth < 6 && node; depth++) {
        const candidates = node.querySelectorAll(
          'div[role="button"], button, .ds-icon-button',
        );
        for (const btn of candidates) {
          if (btn.getAttribute("aria-disabled") === "true") continue;
          if (btn.disabled) continue;
          if (btn.querySelector("svg")) return btn;
        }
        node = node.parentElement;
      }
      return null;
    };

    // ============ 模拟用户输入 ============
    // 【改进点 4】反转注入优先级：
    //   原实现把已废弃的 execCommand("insertText") 当首选，把 React 受控组件
    //   的标准注入方式（原生 value setter + input 事件）当兜底。实际上
    //   execCommand 在新版 Chromium 对 contenteditable 经常静默失败
    //   （返回 true 但没插入）。value setter 才是 React 官方推荐的外部写入方式。
    const simulateTyping = (input, text) => {
      // ① 首选：原生 value setter + input/change 事件（React 会感知）
      try {
        if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
          const proto =
            input.tagName === "TEXTAREA"
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          input.focus();
          setter.call(input, text);
          // React 受控组件监听的是 input 事件（onChange 实际映射到原生 input）
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        // contenteditable 元素：直接改 textContent 并派发 input 事件
        input.focus();
        input.textContent = text;
        input.dispatchEvent(
          new InputEvent("input", { bubbles: true, cancelable: true }),
        );
        return true;
      } catch (e) {
        console.warn("[BiliTK→DS] value setter 注入失败，尝试 execCommand", e);
      }

      // ② 兜底：execCommand("insertText")（已废弃，但某些老环境仍可用）
      try {
        input.focus();
        if (
          (input.tagName === "TEXTAREA" || input.tagName === "INPUT") &&
          typeof input.setSelectionRange === "function"
        ) {
          const len = input.value.length;
          input.setSelectionRange(len, len);
        }
        return document.execCommand("insertText", false, text);
      } catch (e) {
        console.error("[BiliTK→DS] execCommand 也失败", e);
        return false;
      }
    };

    // ============ 模拟用户按 Enter 发送（首选） ============
    // 注意：KeyboardEvent 构造函数的 keyCode/which 是只读遗留属性，
    // 传进 initDict 会被浏览器忽略（永远是 0）。必须用 defineProperty 覆盖，
    // 否则 React 里判断 e.keyCode===13 的逻辑会当成"没按回车"。
    const buildEnterEvent = (type) => {
      const ev = new KeyboardEvent(type, {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      try {
        Object.defineProperty(ev, "keyCode", {
          get: () => 13,
          configurable: true,
        });
        Object.defineProperty(ev, "which", {
          get: () => 13,
          configurable: true,
        });
        Object.defineProperty(ev, "charCode", {
          get: () => 13,
          configurable: true,
        });
      } catch (e) {
        /* 极少数浏览器不允许覆盖，忽略即可 */
      }
      return ev;
    };

    const simulateSend = (input) => {
      // ① 首选：模拟真人按 Enter
      try {
        input.focus();
        input.dispatchEvent(buildEnterEvent("keydown"));
        input.dispatchEvent(buildEnterEvent("keypress"));
        input.dispatchEvent(buildEnterEvent("keyup"));
      } catch (e) {
        console.warn("[BiliTK→DS] 模拟 Enter 失败", e);
      }

      // ② 1 秒后检查：如果输入框已经清空（说明 Enter 生效了），就此结束
      setTimeout(() => {
        const stillHasText =
          input.tagName === "TEXTAREA" || input.tagName === "INPUT"
            ? input.value.trim().length > 0
            : (input.innerText || "").trim().length > 0;

        if (!stillHasText) return; // Enter 已成功发送

        // ③ 兜底：Enter 没生效，再点发送按钮
        const sendBtn = findSendButton(input);
        if (sendBtn) {
          sendBtn.click();
        } else {
          // ④ 再兜底：用 mouse 事件序列点一下（某些按钮只认 mousedown/mouseup）
          const fakeClick = (el) => {
            ["mousedown", "mouseup", "click"].forEach((t) =>
              el.dispatchEvent(
                new MouseEvent(t, {
                  bubbles: true,
                  cancelable: true,
                  view: window,
                }),
              ),
            );
          };
          const guess =
            document.querySelector('div[role="button"].ds-icon-button') ||
            document.querySelector('button[type="submit"]') ||
            document.querySelector('[class*="send"]');
          if (guess) fakeClick(guess);
          else
            console.warn("[BiliTK→DS] 找不到发送按钮，也无法通过 Enter 发送");
        }
      }, 1000);
    };

    const tryInject = () => {
      if (done) return;
      if (++attempts > MAX_ATTEMPTS) return cleanup();

      const input = findInput();
      if (!input) return;

      if (!simulateTyping(input, pending.text)) return cleanup();

      // 等 React 消化一下再发送（Enter 路径里还有 1s 的二次兜底）
      setTimeout(() => {
        simulateSend(input);
        cleanup();
      }, 500);
    };

    timer = setInterval(tryInject, 500);
    setTimeout(tryInject, 1200); // 页面刚加载时也试一次
  }

  // 当前在 DeepSeek 页面 → 只跑注入逻辑，直接退出
  if (location.hostname === "chat.deepseek.com") {
    handleDeepSeekPage();
    return;
  }

  const elements = {
    subtitleStyle: `
<style type="text/css">
/*对齐，悬停按钮显示菜单*/
#subtitle-setting-panel>div>* {margin-right: 5px;}
#bilibili-player-subtitle-btn:hover>#subtitle-setting-panel {display: block!important;}
/*滑动选择样式*/
#subtitle-setting-panel input[type="range"] {
  background-color: #ebeff4;
  -webkit-appearance: none;
  height:4px;
  transform: translateY(-4px);
}
#subtitle-setting-panel input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  height: 15px;
  width: 15px;
  background: #fff;
  border-radius: 15px;
  border: 1px solid;
}
/*复选框和其对应标签样式*/
#subtitle-setting-panel input[type="checkbox"]{display:none;}
#subtitle-setting-panel input ~ label {cursor:pointer;}
#subtitle-setting-panel input:checked ~ label:before {content: '\\2714';}
#subtitle-setting-panel input ~ label:before{
  width: 12px;
  height:12px;
  line-height: 14px;
  vertical-align: text-bottom;
  border-radius: 3px;
  border:1px solid #d3d3d3;
  display: inline-block;
  text-align: center;
  content: ' ';
}
/*悬停显示下拉框样式*/
#subtitle-setting-panel .bpui-selectmenu:hover .bpui-selectmenu-list{display:block;}
/*滚动条样式*/
#subtitle-setting-panel ::-webkit-scrollbar{width: 7px;}
#subtitle-setting-panel ::-webkit-scrollbar-track{border-radius: 4px;background-color: #EEE;}
#subtitle-setting-panel ::-webkit-scrollbar-thumb{border-radius: 4px;background-color: #999;}
/* 新增：拖动时的样式 */
#subtitle-download-dialog.dragging {
    cursor: grabbing !important;
    user-select: none;
}
#subtitle-download-dialog.dragging textarea {
    pointer-events: none;
}
/* 新增：复制按钮样式 */
.copy-clipboard-btn {
    background: #00a1d6 !important;
    margin-left: 5px;
}
.copy-clipboard-btn:hover {
    background: #00a1d6 !important;
}
.copy-success-toast {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(0,0,0,0.8);
    color: #fff;
    padding: 20px 40px;
    border-radius: 8px;
    font-size: 16px;
    z-index: 1048577;
    animation: fadeInOut 2s ease;
}
@keyframes fadeInOut {
    0% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
    20% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    80% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    100% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
}
/* 字幕框右下角的明显缩放手柄 */
.subtitle-textarea-resize-box {
    position: relative;
    width: 500px;
    min-width: 310px;
    height: 410px;
    min-height: 180px;
    max-width: calc(100vw - 40px);
    max-height: calc(100vh - 170px);
}
.subtitle-textarea-resize-box textarea {
    width: 100% !important;
    height: 100% !important;
    box-sizing: border-box;
    resize: none !important;
}
.subtitle-resize-handle {
    position: absolute;
    right: 3px;
    bottom: 3px;
    width: 28px;
    height: 28px;
    border: 2px solid #fff;
    border-radius: 5px;
    background: #00a1d6;
    box-shadow: 0 1px 5px rgba(0,0,0,.35);
    color: #fff;
    cursor: nwse-resize;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    font-weight: bold;
    line-height: 1;
    z-index: 2;
    user-select: none;
}
.subtitle-resize-handle:hover,
.subtitle-resize-handle.active {
    background: #008fbe;
    transform: scale(1.08);
}
</style>`,
    oldEnableIcon: `
<svg width="22" height="28" viewbox="0 0 22 30" xmlns="http://www.w3.org/2000/svg">
  <path id="svg_1" fill-rule="evenodd" fill="#99a2aa" d="m4.07787,6.88102l14,0a2,2 0 0 1 2,2l0,10a2,2 0 0 \
1 -2,2l-14,0a2,2 0 0 1 -2,-2l0,-10a2,2 0 0 1 2,-2zm5,5.5a1,1 0 1 0 0,-2l-3,0a2,2 0 0 0 -2,2l0,3a2,2 0 0 0 \
2,2l3,0a1,1 0 0 0 0,-2l-2,0a1,1 0 0 1 -1,-1l0,-1a1,1 0 0 1 1,-1l2,0zm8,0a1,1 0 0 0 0,-2l-3,0a2,2 0 0 0 -2,2l0\
,3a2,2 0 0 0 2,2l3,0a1,1 0 0 0 0,-2l-2,0a1,1 0 0 1 -1,-1l0,-1a1,1 0 0 1 1,-1l2,0z"/></svg>`,
    oldDisableIcon: `
<svg width="22" height="28" viewBox="0 0 22 32" xmlns="http://www.w3.org/2000/svg">
  <path id="svg_1" fill-rule="evenodd" fill="#99a2aa" d="m15.172,21.87103l-11.172,0a2,2 0 0 1 -2,-2l0,-10c0,\
-0.34 0.084,-0.658 0.233,-0.938l-0.425,-0.426a1,1 0 1 1 1.414,-1.414l15.556,15.556a1,1 0 0 1 -1.414,1.414l-2.192,\
-2.192zm-10.21,-10.21c-0.577,0.351 -0.962,0.986 -0.962,1.71l0,3a2,2 0 0 0 2,2l3,0a1,1 0 0 0 0,-2l-2,0a1,1 0 0 1 -1,\
-1l0,-1a1,1 0 0 1 0.713,-0.958l-1.751,-1.752zm1.866,-3.79l11.172,0a2,2 0 0 1 2,2l0,10c0,0.34 -0.084,0.658 -0.233,\
0.938l-2.48,-2.48a1,1 0 0 0 -0.287,-1.958l-1.672,0l-1.328,-1.328l0,-0.672a1,1 0 0 1 1,-1l2,0a1,1 0 0 0 0,-2l-3,\
0a2,2 0 0 0 -1.977,1.695l-5.195,-5.195z"/></svg>`,
    newDisableIcon: `
        <svg class="squirtle-svg-icon" viewBox="0 0 28 22" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
              <g stroke="none" stroke-width="1" fill="none" fill-rule="evenodd">
                  <path d="M6.998,4 L10.118,7.123 L9.5605,7.1235 C9.4135,6.777 9.151,6.3465 8.8885,6 L7.933,6.3045 C8.101,6.546 8.269,6.8505 8.4055,7.1235 L4.3945,7.1235 L4.3945,9.3705 L5.35,9.3705 L5.35,8.0475 L11.042,8.047 L12.206,9.212 L12.2065,9.3705 L12.364,9.37 L14.494,11.502 L14.389,11.502 L14.389,12.2685 L15.259,12.268 L15.7076026,12.7152226 C15.273892,12.9780418 14.772314,13.2154154 14.2,13.413 C14.3785,13.5705 14.641,13.9275 14.746,14.148 C15.2185,13.959 15.6385,13.7595 16.027,13.5285 L16.027,15.5025 L16.9615,15.5025 L16.961,13.971 L18.536,15.547 L18.5365,15.7125 L18.701,15.712 L20.987,18 L4,18 C2.8954305,18 2,17.1045695 2,16 L2,6 C2,4.8954305 2.8954305,4 4,4 L6.998,4 Z M24,4 C25.1045695,4 26,4.8954305 26,6 L26,16 C26,17.1045695 25.1045695,18 24,18 L23.814,18 L21.2866753,15.470484 C21.499408,15.4571242 21.672579,15.4281871 21.8125,15.366 C22.096,15.24 22.1695,15.0405 22.1695,14.631 L22.1695,13.5915 C22.5475,13.812 22.957,13.98 23.3665,14.106 C23.482,13.8855 23.7445,13.539 23.944,13.3815 C23.0725,13.2675 22.201,12.8685 21.5605,12.2685 L23.7025,12.2685 L23.7025,11.502 L18.2635,11.502 C18.3685,11.3445 18.4735,11.187 18.568,11.019 L22.6,11.019 L22.6,8.079 L15.565,8.079 L15.564,9.743 L13.204,7.381 L13.204,7.1235 L12.946,7.123 L9.825,4 L24,4 Z M11.0725,9.045 L10.852,9.0975 L6.043,9.0975 L6.043,10.0005 L9.865,10.0005 C9.3925,10.3995 8.815,10.809 8.2795,11.0715 L8.2795,11.6805 L4.3,11.6805 L4.3,12.615 L8.2795,12.615 L8.2795,14.547 C8.2795,14.673 8.23321429,14.7295714 8.10096939,14.7431633 L7.788625,14.7522422 C7.4696875,14.7556875 6.938125,14.75175 6.442,14.736 C6.5995,14.988 6.799,15.429 6.862,15.7125 L7.348864,15.710148 C7.95904,15.70242 8.416,15.6705 8.752,15.5445 C9.1825,15.3975 9.319,15.1245 9.319,14.5785 L9.319,12.615 L13.2985,12.615 L13.2985,11.6805 L9.319,11.6805 L9.319,11.397 C10.2115,10.8825 11.0935,10.2 11.734,9.549 L11.0725,9.045 Z M21.235,13.77 L21.235,14.6205 C21.235,14.7255 21.193,14.757 21.0775,14.757 L20.574025,14.7533985 L20.569,14.753 L19.587,13.77 L21.235,13.77 Z M20.5105,12.2685 C20.731,12.531 20.9935,12.7725 21.2875,13.0035 L19.4815,13.0035 L19.4815,12.4575 L18.5365,12.4575 L18.536,12.718 L18.087,12.268 L20.5105,12.2685 Z M16.839,11.019 L17.497,11.019 C17.4212405,11.1536835 17.3319842,11.2816187 17.2292312,11.4082156 L16.839,11.019 Z M21.6235,9.822 L21.6235,10.4205 L16.4995,10.4205 L16.4995,9.822 L21.6235,9.822 Z M21.6235,8.6775 L21.6235,9.255 L16.4995,9.255 L16.4995,8.6775 L21.6235,8.6775 Z M17.791,6.084 L16.8355,6.084 L16.8355,6.7035 L14.452,6.7035 L14.452,7.491 L16.8355,7.491 L16.8355,7.89 L17.791,7.89 L17.791,7.491 L20.269,7.491 L20.269,7.89 L21.2245,7.89 L21.2245,7.491 L23.6605,7.491 L23.6605,6.7035 L21.2245,6.7035 L21.2245,6.084 L20.269,6.084 L20.269,6.7035 L17.791,6.7035 L17.791,6.084 Z" id="形状结合" fill="#FFFFFF"></path>
              </g>
            </svg>`,
    newEnableIcon: `
        <svg class="squirtle-svg-icon" viewBox="0 0 28 22" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
              <g stroke="none" stroke-width="1" fill="none" fill-rule="evenodd">
                  <g transform="translate(2.000000, 0.000000)" fill="#FFFFFF">
                      <path d="M22,3.5 C23.1045695,3.5 24,4.3954305 24,5.5 L24,16.5 C24,17.6045695 23.1045695,18.5 22,18.5 L2,18.5 C0.8954305,18.5 1.3527075e-16,17.6045695 0,16.5 L0,5.5 C-1.3527075e-16,4.3954305 0.8954305,3.5 2,3.5 L22,3.5 Z M9.018,9.1515 L8.7975,9.204 L3.9885,9.204 L3.9885,10.107 L7.8105,10.107 C7.338,10.506 6.7605,10.9155 6.225,11.178 L6.225,11.787 L2.2455,11.787 L2.2455,12.7215 L6.225,12.7215 L6.225,14.6535 C6.225,14.8005 6.162,14.853 5.973,14.853 C5.9065,14.8565 5.78166667,14.8588333 5.62027778,14.8596111 L5.3535,14.8595625 C5.06475,14.85825 4.71825,14.853 4.3875,14.8425 C4.545,15.0945 4.7445,15.5355 4.8075,15.819 C5.6685,15.819 6.2775,15.8085 6.6975,15.651 C7.128,15.504 7.2645,15.231 7.2645,14.685 L7.2645,12.7215 L11.244,12.7215 L11.244,11.787 L7.2645,11.787 L7.2645,11.5035 C8.157,10.989 9.039,10.3065 9.6795,9.6555 L9.018,9.1515 Z M20.799,8.1855 L13.764,8.1855 L13.764,11.1255 L15.696,11.1255 C15.6015,11.2935 15.486,11.451 15.3495,11.6085 L12.588,11.6085 L12.588,12.375 L14.5515,12.375 C13.995,12.816 13.281,13.215 12.399,13.5195 C12.5775,13.677 12.84,14.034 12.945,14.2545 C13.4175,14.0655 13.8375,13.866 14.226,13.635 L14.226,15.609 L15.1605,15.609 L15.1605,13.8765 L16.7355,13.8765 L16.7355,15.819 L17.6805,15.819 L17.6805,13.8765 L19.434,13.8765 L19.434,14.727 C19.434,14.832 19.392,14.8635 19.2765,14.8635 L19.15575,14.8633359 C18.9962813,14.8628437 18.7305,14.860875 18.447,14.853 C18.552,15.0735 18.657,15.357 18.699,15.588 C19.308,15.588 19.728,15.5985 20.0115,15.4725 C20.295,15.3465 20.3685,15.147 20.3685,14.7375 L20.3685,13.698 C20.7465,13.9185 21.156,14.0865 21.5655,14.2125 C21.681,13.992 21.9435,13.6455 22.143,13.488 C21.2715,13.2675 20.4,12.8685 19.7595,12.375 L21.9015,12.375 L21.9015,11.6085 L16.4625,11.6085 C16.5675,11.451 16.6725,11.2935 16.767,11.1255 L20.799,11.1255 L20.799,8.1855 Z M18.7095,12.375 C18.93,12.6375 19.1925,12.879 19.4865,13.11 L17.6805,13.11 L17.6805,12.564 L16.7355,12.564 L16.7355,13.11 L15.0135,13.11 C15.318,12.879 15.591,12.6375 15.8325,12.375 L18.7095,12.375 Z M19.8225,9.9285 L19.8225,10.527 L14.6985,10.527 L14.6985,9.9285 L19.8225,9.9285 Z M6.834,6.1065 L5.8785,6.411 C6.0465,6.6525 6.2145,6.957 6.351,7.23 L2.34,7.23 L2.34,9.477 L3.2955,9.477 L3.2955,8.154 L10.152,8.154 L10.152,9.477 L11.1495,9.477 L11.1495,7.23 L7.506,7.23 C7.359,6.8835 7.0965,6.453 6.834,6.1065 Z M19.8225,8.784 L19.8225,9.3615 L14.6985,9.3615 L14.6985,8.784 L19.8225,8.784 Z M15.99,6.1905 L15.0345,6.1905 L15.0345,6.81 L12.651,6.81 L12.651,7.5975 L15.0345,7.5975 L15.0345,7.9965 L15.99,7.9965 L15.99,7.5975 L18.468,7.5975 L18.468,7.9965 L19.4235,7.9965 L19.4235,7.5975 L21.8595,7.5975 L21.8595,6.81 L19.4235,6.81 L19.4235,6.1905 L18.468,6.1905 L18.468,6.81 L15.99,6.81 L15.99,6.1905 Z" id="形状结合"></path>
                  </g>
              </g>
            </svg>`,
    createAs(nodeType, config, appendTo) {
      const element = document.createElement(nodeType);
      config && this.setAs(element, config);
      appendTo && appendTo.appendChild(element);
      return element;
    },
    setAs(element, config, appendTo) {
      config &&
        Object.entries(config).forEach(([key, value]) => {
          element[key] = value;
        });
      appendTo && appendTo.appendChild(element);
      return element;
    },
    getAs(selector, config, appendTo) {
      if (selector instanceof Array) {
        return selector.map((item) => this.getAs(item));
      }
      const element = document.body.querySelector(selector);
      element && config && this.setAs(element, config);
      element && appendTo && appendTo.appendChild(element);
      return element;
    },
    createSelector(config, appendTo) {
      const selector = this.createAs(
          "div",
          {
            className:
              "bilibili-player-block-string-type bpui-component bpui-selectmenu selectmenu-mode-absolute",
            style: "width:" + config.width,
          },
          appendTo,
        ),
        selected = config.datas.find((item) => item.value == config.initValue),
        label = this.createAs(
          "div",
          {
            className: "bpui-selectmenu-txt",
            innerHTML: selected ? selected.content : config.initValue,
          },
          selector,
        ),
        arraw = this.createAs(
          "div",
          {
            className: "bpui-selectmenu-arrow bpui-icon bpui-icon-arrow-down",
          },
          selector,
        ),
        list = this.createAs(
          "ul",
          {
            className: "bpui-selectmenu-list bpui-selectmenu-list-left",
            style: `max-height:${config.height || "100px"};overflow:hidden auto;white-space:nowrap;`,
            onclick: (e) => {
              label.dataset.value = e.target.dataset.value;
              label.innerHTML = e.target.innerHTML;
              config.handler(e.target.dataset.value);
            },
          },
          selector,
        );
      config.datas.forEach((item) => {
        this.createAs(
          "li",
          {
            className: "bpui-selectmenu-list-row",
            innerHTML: item.content,
          },
          list,
        ).dataset.value = item.value;
      });
      return selector;
    },
    createRadio(config, appendTo) {
      this.createAs(
        "input",
        {
          ...config,
          type: "radio",
          style: "cursor:pointer;5px;vertical-align: middle;",
        },
        appendTo,
      );
      this.createAs(
        "label",
        {
          style: "margin-right: 5px;cursor:pointer;vertical-align: middle;",
          innerText: config.value,
        },
        appendTo,
      ).setAttribute("for", config.id);
    },
  };

  // ==================== 公共UI工具：拖拽与状态管理 ====================
  const uiManager = {
    dragMap: new WeakMap(),
    makeDraggable(handle, container, options = {}) {
      const state = { isDragging: false, offsetX: 0, offsetY: 0 };
      const onMouseDown = (e) => {
        if (
          e.target.closest("button, a, select, input, textarea, [data-no-drag]")
        )
          return;
        e.preventDefault();
        e.stopPropagation();
        state.isDragging = true;
        const rect = container.getBoundingClientRect();
        state.offsetX = e.clientX - rect.left;
        state.offsetY = e.clientY - rect.top;
        handle.style.cursor = "grabbing";
        container.style.transition = "none";
        container.classList.add("dragging");
      };
      const onMouseMove = (e) => {
        if (!state.isDragging) return;
        let x = e.clientX - state.offsetX;
        let y = e.clientY - state.offsetY;
        const maxX = window.innerWidth - container.offsetWidth;
        const maxY = window.innerHeight - container.offsetHeight;
        x = Math.max(0, Math.min(x, maxX));
        y = Math.max(0, Math.min(y, maxY));
        container.style.left = x + "px";
        container.style.top = y + "px";
        container.style.transform = "none";
        if (options.onMove) options.onMove(x, y);
      };
      const onMouseUp = () => {
        if (!state.isDragging) return;
        state.isDragging = false;
        handle.style.cursor = "move";
        container.style.transition = options.transition || "";
        container.classList.remove("dragging");
        if (options.onEnd) options.onEnd();
      };
      handle.addEventListener("mousedown", onMouseDown);
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      this.dragMap.set(container, {
        destroy() {
          handle.removeEventListener("mousedown", onMouseDown);
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
        },
      });
      return this.dragMap.get(container);
    },
    // 【改进点 13】统一 toast 实现：
    //   统一转发到 encoder.showToast，保证全局只有一份 toast 实现。
    //   因为 encoder 定义在后面，这里用 typeof 做运行时检查。
    showToast(message, type = "success") {
      if (typeof encoder !== "undefined" && encoder.showToast) {
        encoder.showToast(message, type);
        return;
      }
      console.warn("[BiliTK toast]", message);
    },
    saveState(key, state) {
      try {
        localStorage.setItem(key, JSON.stringify(state));
      } catch (e) {}
    },
    loadState(key, defaults) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : defaults;
      } catch (e) {
        return defaults;
      }
    },
  };

  function fetch(url, option = {}) {
    return new Promise((resolve, reject) => {
      const req = new XMLHttpRequest();
      req.onreadystatechange = () => {
        if (req.readyState === 4) {
          resolve({
            ok: req.status >= 200 && req.status <= 299,
            status: req.status,
            statusText: req.statusText,
            body: req.response,
            json: () => Promise.resolve(JSON.parse(req.responseText)),
            text: () => Promise.resolve(req.responseText),
          });
        }
      };
      if (option.credentials == "include") req.withCredentials = true;
      req.onerror = reject;
      req.open("GET", url);
      req.send();
    });
  }

  //编码器，用于将B站BCC字幕编码为常见字幕格式下载
  const encoder = {
    assHead: [
      "[Script Info]",
      `Title: ${document.title}`,
      "ScriptType: v4.00+",
      "Collisions: Reverse",
      "PlayResX: 1280",
      "PlayResY: 720",
      "WrapStyle: 3",
      "ScaledBorderAndShadow: yes",
      "; ----------------------",
      "; 本字幕由CC字幕助手自动转换",
      `; 字幕来源${document.location}`,
      "; 脚本地址https://greasyfork.org/scripts/378513",
      "; 设置了字幕过长自动换行，但若字幕中没有空格换行将无效",
      "; 字体大小依据720p 48号字体等比缩放",
      "; 如显示不正常请尝试使用SRT格式",
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, " +
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, " +
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      "Style: Default,Segoe UI,48,&H00FFFFFF,&HF0000000,&H00000000,&HF0000000,1,0,0,0,100,100,0,0.00,1,1,3,2,30,30,20,1",
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Actor, MarginL, MarginR, MarginV, Effect, Text",
    ],

    // ==================== 拖动相关变量 ====================
    isDragging: false,
    dragOffsetX: 0,
    dragOffsetY: 0,
    dialogElement: null,
    panelElement: null,
    currentLan: null,
    languageSelect: null,
    languageStatus: null,
    formatSelect: null,
    resizeContainer: null,

    // ==================== 显示字幕窗口 ====================
    showDialog(data, download, lan) {
      if (!data || !(data.body instanceof Array)) {
        throw "数据错误";
      }
      this.data = data;
      this.currentLan = lan || null;
      const settingDiv = elements.createAs(
          "div",
          {
            style:
              "position: fixed;top: 0;bottom: 0;left: 0;right: 0;background: transparent;pointer-events:none;z-index: 1048576;" +
              (download ? "display:none" : ""),
          },
          document.body,
        ),
        panel = (this.panelElement = elements.createAs(
          "div",
          {
            id: "subtitle-download-panel",
            style:
              "left:50%;top:50%;position:absolute;padding:15px;min-width:340px;max-width:calc(100vw - 20px);box-sizing:border-box;background:white;border-radius:8px;margin:auto;transform:translate(-50%,-50%);pointer-events:auto;box-shadow:0 4px 18px rgba(0,0,0,.18);",
          },
          settingDiv,
        )),
        header = elements.createAs(
          "div",
          {
            style:
              "position:relative;min-height:36px;margin-bottom:5px;cursor:move;user-select:none;line-height:1;",
          },
          panel,
        );
      elements.createAs(
        "span",
        {
          innerText: "字幕批量下载复制查看器",
          style:
            "display:block;max-width:240px;white-space:nowrap;font-size:20px;line-height:24px;color:#00a1d6;font-weight:500;",
        },
        header,
      );
      this.dialogElement = settingDiv;
      elements.createAs(
        "a",
        {
          href: "https://greasyfork.org/scripts/378513",
          target: "_blank",
          style:
            "position:absolute;right:0;top:0;color:#606060;font-size:13px;white-space:nowrap;",
          innerHTML: `当前版本：${(typeof GM_info != "undefined" && GM_info.script.version) || "1.0"}`,
        },
        header,
      );
      elements.createAs(
        "span",
        {
          style:
            "position:absolute;right:0;top:19px;color:#99a2aa;font-size:12px;white-space:nowrap;",
          innerText: "窗口可拖动，点击⌜⌟可调整窗口大小",
        },
        header,
      );
      const resizeContainer = (this.resizeContainer = elements.createAs(
          "div",
          {
            className: "subtitle-textarea-resize-box",
            style:
              "position:relative;width:500px;min-width:310px;height:410px;min-height:180px;max-width:calc(100vw - 40px);max-height:calc(100vh - 170px);",
          },
          panel,
        )),
        textArea = (this.textArea = elements.createAs(
          "textarea",
          {
            style:
              "width:100%;height:100%;box-sizing:border-box;resize:none;padding:5px;line-height:normal;border:1px solid #e5e9ef;margin:0px;",
          },
          resizeContainer,
        )),
        resizeHandle = elements.createAs(
          "div",
          {
            className: "subtitle-resize-handle",
            style:
              "position:absolute;right:3px;bottom:3px;width:32px;height:32px;border:2px solid #fff;border-radius:5px;background:#00a1d6;box-shadow:0 1px 5px rgba(0,0,0,.35);color:#fff;cursor:nwse-resize;display:flex;align-items:center;justify-content:center;z-index:2;user-select:none;",
            innerHTML:
              '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 2H2v5M13 18h5v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
            title: "点击或拖动此处调整字幕框大小",
            onmousedown: (e) => e.stopPropagation(),
          },
          resizeContainer,
        );
      textArea.setAttribute("readonly", true);
      this.initTextAreaResize(resizeHandle, resizeContainer, panel);

      const availableLanguages =
        this.currentLan && typeof bilibiliCCHelper !== "undefined"
          ? (bilibiliCCHelper.subtitle?.subtitles || []).filter(
              (item) => item.lan !== "close" && item.lan !== "local",
            )
          : [];
      if (availableLanguages.length) {
        const languagePanel = elements.createAs(
          "div",
          { style: "font-size:14px; padding-top: 10px;" },
          panel,
        );
        elements.createAs(
          "span",
          { innerText: "语言：", style: "margin-right:5px;" },
          languagePanel,
        );
        this.languageSelect = elements.createAs(
          "select",
          {
            style: "height: 24px; margin-right: 5px; min-width: 120px;",
            innerHTML: availableLanguages
              .map(
                (item) =>
                  `<option value="${item.lan}">${item.lan_doc || item.lan}</option>`,
              )
              .join(""),
            value: this.currentLan,
            onchange: (ev) => this.changeLanguage(ev.target.value),
          },
          languagePanel,
        );
        this.refreshButton = elements.createAs(
          "a",
          {
            innerText: "刷新",
            style:
              "height: 24px;margin-right: 5px;background: #00a1d6;color: #fff;padding: 7px;cursor: pointer;",
            onclick: (e) => {
              e.preventDefault();
              e.stopPropagation();
              this.refreshCurrentSubtitle();
            },
          },
          languagePanel,
        );
        this.languageStatus = elements.createAs(
          "span",
          { style: "color:#99a2aa;font-size:12px;" },
          languagePanel,
        );
      } else {
        this.languageSelect = null;
        this.languageStatus = null;
      }
      const bottomPanel = elements.createAs(
        "div",
        { style: "font-size:14px; padding-top: 10px;" },
        panel,
      );
      const type = localStorage.defaultSubtitleType || "SRT";
      this.formatSelect = elements.createAs(
        "select",
        {
          style: "height: 24px; margin-right: 5px;",
          innerHTML: ["ASS", "SRT", "LRC", "VTT", "TXT", "BCC"]
            .map((type) => `<option value="${type}">${type}</option>`)
            .join(""),
          value: type,
          onchange: (ev) => this.updateDownload(ev.target.value),
        },
        bottomPanel,
      );
      this.actionButton = elements.createAs(
        "a",
        {
          title: "按住Ctrl键点击字幕列表的下载可不打开预览直接下载当前格式",
          innerText: "下载",
          style:
            "height: 24px;margin-right: 5px;background: #00a1d6;color: #fff;padding: 7px;",
          onclick: (e) => e.stopPropagation(),
          oncontextmenu: (e) => e.stopPropagation(),
        },
        bottomPanel,
      );
      this.batchButton = elements.createAs(
        "a",
        {
          innerText: "批量下载",
          style:
            "height: 24px;margin-right: 5px;background: #00a1d6;color: #fff;padding: 7px;cursor: pointer;",
          href: "javascript:",
          onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            bilibiliCCHelper.openBatchDialog();
          },
          oncontextmenu: (e) => e.stopPropagation(),
        },
        bottomPanel,
      );
      this.copyButton = elements.createAs(
        "a",
        {
          innerText: "复制",
          style:
            "height: 24px;margin-right: 5px;background: #00a1d6;color: #fff;padding: 7px;cursor: pointer;",
          href: "javascript:",
          onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.copyToClipboard();
          },
          oncontextmenu: (e) => e.stopPropagation(),
        },
        bottomPanel,
      );
      this.openTabButton = elements.createAs(
        "a",
        {
          innerText: "在新标签页中打开",
          style:
            "height: 24px;margin-right: 5px;background: #00a1d6;color: #fff;padding: 7px;",
          target: "_blank",
          onclick: (e) => e.stopPropagation(),
          oncontextmenu: (e) => e.stopPropagation(),
        },
        bottomPanel,
      );
      this.closeButton = elements.createAs(
        "a",
        {
          innerText: "关闭",
          style:
            "height: 24px;margin-right: 5px;background: #00a1d6;color: #fff;padding: 7px;cursor: pointer;",
          onclick: () => {
            // 【改进点 2】关闭对话框前先清理拖动监听，避免全局监听泄漏
            if (typeof this._destroyDrag === "function") {
              this._destroyDrag();
              this._destroyDrag = null;
            }
            document.body.removeChild(settingDiv);
          },
        },
        bottomPanel,
      );

      // 【改进点 2】保存销毁函数，关闭对话框时用来清理全局拖动监听
      this._destroyDrag = this.initDragging(header, panel);

      // 默认转换SRT格式
      this.updateDownload(type, download);
    },

    changeLanguage(lan) {
      if (!lan || typeof bilibiliCCHelper === "undefined") return;
      this.currentLan = lan;
      if (this.languageStatus) this.languageStatus.innerText = "加载中…";
      bilibiliCCHelper
        .getSubtitle(lan)
        .then((data) => {
          this.data = data;
          this.updateDownload(
            this.formatSelect ? this.formatSelect.value : "SRT",
          );
          if (this.languageStatus) this.languageStatus.innerText = "已切换";
        })
        .catch((e) => {
          if (this.languageStatus) this.languageStatus.innerText = "加载失败";
          bilibiliCCHelper.toast("切换字幕失败", e);
        });
    },

    refreshCurrentSubtitle() {
      if (!this.currentLan || typeof bilibiliCCHelper === "undefined") return;
      if (this.languageStatus) this.languageStatus.innerText = "刷新中…";
      bilibiliCCHelper
        .setupData(true)
        .then(() => {
          bilibiliCCHelper.datas = { close: { body: [] }, local: { body: [] } };
          return bilibiliCCHelper.getSubtitle(this.currentLan);
        })
        .then((data) => {
          this.data = data;
          this.updateDownload(
            this.formatSelect ? this.formatSelect.value : "SRT",
          );
          if (this.languageStatus) this.languageStatus.innerText = "已刷新";
        })
        .catch((e) => {
          if (this.languageStatus) this.languageStatus.innerText = "刷新失败";
          bilibiliCCHelper.toast("刷新字幕失败", e);
        });
    },

    // 让右下角的蓝色手柄直接调整字幕文本框大小
    initTextAreaResize(handle, container, panel) {
      const minWidth = 310;
      const minHeight = 180;
      let resizing = false;
      let startX = 0;
      let startY = 0;
      let startWidth = 0;
      let startHeight = 0;

      const onMove = (e) => {
        if (!resizing) return;
        const maxWidth = Math.max(minWidth, window.innerWidth - 40);
        const maxHeight = Math.max(minHeight, window.innerHeight - 170);
        const width = Math.max(
          minWidth,
          Math.min(maxWidth, startWidth + e.clientX - startX),
        );
        const height = Math.max(
          minHeight,
          Math.min(maxHeight, startHeight + e.clientY - startY),
        );
        container.style.width = width + "px";
        container.style.height = height + "px";
        if (panel) panel.style.width = Math.max(340, width + 30) + "px";
      };
      const onUp = () => {
        if (!resizing) return;
        resizing = false;
        handle.classList.remove("active");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = container.getBoundingClientRect();
        resizing = true;
        startX = e.clientX;
        startY = e.clientY;
        startWidth = rect.width;
        startHeight = rect.height;
        handle.classList.add("active");
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    },

    // ==================== 拖动功能 ====================
    // 【改进点 2】把拖动监听抽成命名函数，并返回 destroy 函数。
    //   原实现每次 showDialog 都会往 document 上挂一份 mousemove / mouseup，
    //   但从不移除。开关窗口 20 次就会有 20 份监听在跑，越拖越卡。
    //   现在由调用方在对话框关闭时调用 destroy 清理。
    initDragging(handle, container) {
      const self = this;

      const onMouseDown = function (e) {
        // 排除点击按钮或版本链接的情况，避免意外拖动
        if (
          e.target.tagName === "BUTTON" ||
          e.target.tagName === "A" ||
          e.target.innerHTML === "×"
        )
          return;
        e.stopPropagation();
        self.isDragging = true;
        const rect = container.getBoundingClientRect();
        self.dragOffsetX = e.clientX - rect.left;
        self.dragOffsetY = e.clientY - rect.top;
        handle.style.cursor = "grabbing";
        container.style.transition = "none";
        e.preventDefault();
      };

      const onMouseMove = function (e) {
        if (!self.isDragging) return;
        const x = e.clientX - self.dragOffsetX;
        const y = e.clientY - self.dragOffsetY;
        const maxX = window.innerWidth - container.offsetWidth;
        const maxY = window.innerHeight - container.offsetHeight;
        const clampedX = Math.max(0, Math.min(x, maxX));
        const clampedY = Math.max(0, Math.min(y, maxY));
        container.style.left = clampedX + "px";
        container.style.top = clampedY + "px";
        container.style.transform = "none";
      };

      const onMouseUp = function () {
        if (self.isDragging) {
          self.isDragging = false;
          handle.style.cursor = "move";
          container.style.transition = "transform 0.2s, left 0.2s, top 0.2s";
        }
      };

      handle.addEventListener("mousedown", onMouseDown);
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);

      // 返回销毁函数，供对话框关闭时调用
      return function destroy() {
        handle.removeEventListener("mousedown", onMouseDown);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };
    },

    // ==================== 一键复制功能 ====================
    copyToClipboard() {
      const text = this.textArea.value;
      if (!text || text.length === 0) {
        this.showToast("没有可复制的内容！", "error");
        return;
      }

      try {
        // 使用GM_setClipboard（油猴API）或navigator.clipboard
        if (typeof GM_setClipboard !== "undefined") {
          GM_setClipboard(text, "text");
          this.showCopySuccess();
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard
            .writeText(text)
            .then(() => {
              this.showCopySuccess();
            })
            .catch((err) => {
              this.fallbackCopy(text);
            });
        } else {
          this.fallbackCopy(text);
        }
      } catch (e) {
        this.fallbackCopy(text);
      }
    },

    // 备用复制方案
    fallbackCopy(text) {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-9999px";
      textArea.style.top = "0";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();

      try {
        const successful = document.execCommand("copy");
        if (successful) {
          this.showCopySuccess();
        } else {
          this.showToast("❌ 复制失败，请手动复制", "error");
        }
      } catch (err) {
        this.showToast("❌ 复制失败，请手动复制", "error");
      }

      document.body.removeChild(textArea);
    },

    showCopySuccess() {
      this.showToast("✅ 复制成功！已保存到剪贴板");
      if (this.copyButton) {
        const button = this.copyButton;
        button.innerText = "已复制 ✓";
        button.style.background = "#20b26b";
        clearTimeout(this.copyResetTimer);
        this.copyResetTimer = setTimeout(() => {
          if (button.parentNode) {
            button.innerText = "复制";
            button.style.background = "#00a1d6";
          }
        }, 1800);
      }
    },

    // 显示提示
    showToast(message, type = "success") {
      // 移除已存在的toast
      const existing = document.querySelector(".copy-success-toast");
      if (existing) existing.remove();

      const toast = elements.createAs(
        "div",
        {
          className: "copy-success-toast",
          innerText: message,
          style: `position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:1048579;background:${type === "error" ? "#e85d5d" : "#20b26b"};color:#fff;padding:12px 22px;border-radius:6px;font-size:14px;line-height:1.4;box-shadow:0 3px 12px rgba(0,0,0,.28);pointer-events:none;white-space:nowrap;animation:none;`,
        },
        document.body,
      );

      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 2000);
    },

    updateDownload(type = "LRC", download) {
      let result;
      let blobResult;
      switch (type) {
        case "LRC":
          result = this.encodeToLRC(this.data.body);
          break;
        case "SRT":
          result = this.encodeToSRT(this.data.body);
          break;
        case "ASS":
          result = this.encodeToASS(this.data.body);
          break;
        case "VTT":
          result = this.encodeToVTT(this.data.body);
          break;
        case "TXT":
          result = this.data.body.map((item) => item.content).join("\r\n");
          break;
        case "BCC":
          result = JSON.stringify(this.data, undefined, 2);
          break;
        default:
          result = "错误：无法识别的格式 " + type;
          break;
      }
      this.textArea.value = result;
      localStorage.defaultSubtitleType = type;
      type = type.toLowerCase();
      URL.revokeObjectURL(this.actionButton.href);
      this.actionButton.classList.remove(
        "bpui-state-disabled",
        "bui-button-disabled",
      );
      blobResult = new Blob([result], {
        type: "text/" + type + ";charset=utf-8",
      });
      this.actionButton.href = URL.createObjectURL(blobResult);
      this.openTabButton.href = URL.createObjectURL(blobResult);
      this.actionButton.download = `${bilibiliCCHelper.getInfo("h1Title") || document.title}.${type}`;
      if (download) {
        this.actionButton.click();
        this.closeButton.click();
      }
    },
    encodeToLRC(data) {
      return data
        .map(({ from, to, content }) => {
          return `${this.encodeTime(from, "LRC")} ${content.replace(/\n/g, " ")}`;
        })
        .join("\r\n");
    },
    encodeToSRT(data) {
      return data
        .map(({ from, to, content }, index) => {
          return `${index + 1}\r\n${this.encodeTime(from)} --> ${this.encodeTime(to)}\r\n${content}`;
        })
        .join("\r\n\r\n");
    },
    encodeToVTT(data) {
      return (
        "WEBVTT \r\n\r\n" +
        data
          .map(({ from, to, content }, index) => {
            return `${index + 1}\r\n${this.encodeTime(from, "VTT")} --> ${this.encodeTime(to, "VTT")}\r\n${content}`;
          })
          .join("\r\n\r\n")
      );
    },
    encodeToASS(data) {
      this.assHead[1] = `Title: ${document.title}`;
      this.assHead[10] = `; 字幕来源${document.location}`;
      return this.assHead
        .concat(
          data.map(({ from, to, content }) => {
            return `Dialogue: 0,${this.encodeTime(from, "ASS")},${this.encodeTime(to, "ASS")},*Default,NTP,0000,0000,0000,,${content.replace(/\n/g, "\\N")}`;
          }),
        )
        .join("\r\n");
    },
    //这里作者原本的脚本有问题，我更改过
    encodeTime(input, format = "SRT") {
      const time = new Date(input * 1000);
      const ms = time.getMilliseconds();
      const second = time.getSeconds();
      const minute = time.getMinutes();
      const hour = Math.floor(input / 60 / 60);
      const pad = (n, len = 2) => String(n).padStart(len, "0");

      if (format === "SRT" || format === "VTT") {
        return (
          `${pad(hour)}:${pad(minute)}:${pad(second)}` +
          `${format === "SRT" ? "," : "."}${pad(ms, 3)}`
        );
      }
      if (format === "ASS") {
        return `${hour}:${pad(minute)}:${pad(second)}.${pad(Math.floor(ms / 10), 2)}`;
      }
      // LRC
      const totalMin = minute + hour * 60;
      return `[${pad(totalMin)}:${pad(second)}.${pad(Math.floor(ms / 10), 2)}]`;
    },
  };

  //解码器，用于读取常见格式字幕并将其转换为B站可以读取BCC格式字幕
  const decoder = {
    srtReg:
      /(?:(\d+):)?(\d{1,2}):(\d{1,2})[,\.](\d{1,3})\s*(?:-->|,)\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[,\.](\d{1,3})\r?\n([.\s\S]+)/,
    assReg:
      /Dialogue:.*,(\d+):(\d{1,2}):(\d{1,2}\.?\d*),\s*?(\d+):(\d{1,2}):(\d{1,2}\.?\d*)(?:.*?,){7}(.+)/,
    encodings: ["UTF-8", "GB18030", "BIG5", "UNICODE", "JIS", "EUC-KR"],
    encoding: "UTF-8",
    dialog: undefined,
    reader: undefined,
    file: undefined,
    data: undefined,
    statusHandler: undefined,

    // ==================== 拖动相关变量 ====================
    isDragging: false,
    dragOffsetX: 0,
    dragOffsetY: 0,

    show(handler) {
      this.statusHandler = handler;

      // 【改进点 15】判空播放器容器：
      //   某些页面（独立播放器、番剧切换中）可能没有 #bilibiliPlayer，
      //   此时 createAs 的 appendTo 为 null 会被静默跳过，导致面板
      //   "打不开"却毫无提示。这里显式判空并给出可读的反馈。
      const playerEl = elements.getAs("#bilibiliPlayer");
      if (!playerEl) {
        bilibiliCCHelper.toast("找不到播放器容器，无法打开本地字幕面板");
        return;
      }

      if (!this.dialog) {
        this.moveAction = (ev) => this.dialogMove(ev);
        this.dialog = elements.createAs(
          "div",
          {
            id: "subtitle-local-selector",
            style:
              "position:fixed;z-index:1048576;padding:10px;top:50%;left:calc(50% - 185px);box-shadow: 0 0 4px #e5e9ef;border: 1px solid #e5e9ef;background:white;border-radius:5px;color:#99a2aa",
          },
          playerEl,
        );
        // 标题栏，保留拖动功能
        const header = elements.createAs(
          "div",
          {
            style:
              "margin-bottom: 5px;cursor:move;user-select:none;line-height:1;",
            innerText: "本地字幕选择",
          },
          this.dialog,
        );
        elements.createAs(
          "input",
          {
            style: "margin-bottom: 5px;width: 370px;",
            innerText: "选择字幕",
            type: "file",
            accept: ".lrc,.ass,.ssa,.srt,.bcc,.sbv,.vtt",
            oninput: ({ target }) =>
              this.readFile((this.file = target.files && target.files[0])),
          },
          this.dialog,
        );
        elements.createAs("br", {}, this.dialog);
        elements.createAs(
          "label",
          { style: "margin-right: 10px;", innerText: "字幕编码" },
          this.dialog,
        );
        elements.createAs(
          "select",
          {
            style:
              "width: 80px;height: 20px;border-radius: 4px;line-height: 20px;border:1px solid #ccd0d7;",
            title: "如果字幕乱码可尝试更改编码",
            innerHTML: this.encodings.reduce(
              (result, item) =>
                `${result}<option value="${item}">${item}</option>`,
              "",
            ),
            oninput: ({ target }) =>
              this.readFile((this.encoding = target.value)),
          },
          this.dialog,
        );
        elements.createAs(
          "label",
          {
            style: "margin-left: 10px;",
            innerText: "时间偏移(s)",
            title: "字幕相对于视频的时间偏移，双击此标签复位时间偏移",
            ondblclick: () =>
              +this.offset.value &&
              this.handleSubtitle((this.offset.value = 0)),
          },
          this.dialog,
        );
        this.offset = elements.createAs(
          "input",
          {
            style:
              "margin-left: 10px;width: 50px;border: 1px solid #ccd0d7;border-radius: 4px;line-height: 20px;",
            type: "number",
            step: 0.5,
            value: 0,
            title: "负值表示将字幕延后，正值将字幕提前",
            oninput: () => this.handleSubtitle(),
          },
          this.dialog,
        );
        elements.createAs(
          "button",
          {
            style: "margin-left: 10px;border:none;width:max-content;",
            innerText: "关闭面板",
            className: "bpui-button bui bui-button bui-button-blue",
            onclick: () => {
              // 【改进点 2】关闭面板前清理拖动监听
              if (typeof this._destroyDrag === "function") {
                this._destroyDrag();
                this._destroyDrag = null;
              }
              playerEl.removeChild(this.dialog);
            },
          },
          this.dialog,
        );
        this.reader = new FileReader();
        this.reader.onloadend = () => this.decodeFile();
        this.reader.onerror = (e) => bilibiliCCHelper.toast("载入字幕失败", e);
        // 保存 header 引用，供后续重绑拖动使用
        this._dragHandle = header;
      } else {
        playerEl.appendChild(this.dialog);
        this.handleSubtitle();
      }

      // 【改进点 2】每次显示都重新绑定拖动监听（上次关闭时已销毁）
      if (typeof this._destroyDrag === "function") this._destroyDrag();
      this._destroyDrag = this.initDragging(this._dragHandle, this.dialog);
    },

    // 【改进点 2】同 encoder.initDragging：返回 destroy 供关闭时清理监听
    initDragging(handle, container) {
      const self = this;

      const onMouseDown = function (e) {
        if (e.target.innerHTML === "×") return; // 排除关闭按钮
        e.stopPropagation();
        self.isDragging = true;
        const rect = container.getBoundingClientRect();
        self.dragOffsetX = e.clientX - rect.left;
        self.dragOffsetY = e.clientY - rect.top;
        handle.style.cursor = "grabbing";
        container.style.transition = "none";
        e.preventDefault();
      };

      const onMouseMove = function (e) {
        if (!self.isDragging) return;
        const x = e.clientX - self.dragOffsetX;
        const y = e.clientY - self.dragOffsetY;
        const maxX = window.innerWidth - container.offsetWidth;
        const maxY = window.innerHeight - container.offsetHeight;
        container.style.left = Math.max(0, Math.min(x, maxX)) + "px";
        container.style.top = Math.max(0, Math.min(y, maxY)) + "px";
        container.style.transform = "none";
      };

      const onMouseUp = function () {
        if (self.isDragging) {
          self.isDragging = false;
          handle.style.cursor = "move";
        }
      };

      handle.addEventListener("mousedown", onMouseDown);
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);

      return function destroy() {
        handle.removeEventListener("mousedown", onMouseDown);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };
    },

    dialogMove(ev) {
      // 已废弃，改用新的拖动系统
    },
    readFile() {
      if (!this.file) {
        this.data = undefined;
        return bilibiliCCHelper.toast("没有文件");
      }
      this.reader.readAsText(this.file, this.encoding);
    },
    handleSubtitle() {
      if (!this.data) return;
      const offset = +this.offset.value;
      bilibiliCCHelper
        .updateLocal(
          !offset
            ? this.data
            : {
                body: this.data.body.map(({ from, to, content }) => ({
                  from: from - offset,
                  to: to - offset,
                  content,
                })),
              },
        )
        .then(() => {
          if ("function" == typeof this.statusHandler) this.statusHandler(true);
          bilibiliCCHelper.toast(
            `载入本地字幕:${this.file.name},共${this.data.body.length}行,偏移:${offset}s`,
          );
        })
        .catch((e) => {
          bilibiliCCHelper.toast("载入字幕失败", e);
        });
    },
    decodeFile() {
      try {
        const type = this.file.name.split(".").pop().toLowerCase();
        switch (type) {
          case "lrc":
            this.data = this.decodeFromLRC(this.reader.result);
            break;
          case "ass":
          case "ssa":
            this.data = this.decodeFromASS(this.reader.result);
            break;
          case "srt":
          case "sbv":
          case "vtt":
            this.data = this.decodeFromSRT(this.reader.result);
            break;
          case "bcc":
            this.data = JSON.parse(this.reader.result);
            break;
          default:
            throw "未知文件类型" + type;
            break;
        }
        console.log(this.data);
        this.handleSubtitle();
      } catch (e) {
        bilibiliCCHelper.toast("解码字幕文件失败", e);
      }
    },
    decodeFromLRC(input) {
      if (!input) return;
      const data = [];
      input.split("\n").forEach((line) => {
        let match = line.match(/((\[\d+:\d+\.?\d*\])+)(.*)/);
        if (!match) {
          if ((match = line.match(/\[offset:(\d+)\]/i))) {
            this.offset.value = +match[1] / 1000;
          }
          return;
        }
        const times = match[1].match(/\d+:\d+\.?\d*/g);
        times.forEach((time) => {
          const t = time.split(":");
          data.push({
            time: t[0] * 60 + +t[1],
            content: match[3].trim().replace("\r", ""),
          });
        });
      });
      return {
        body: data
          .sort((a, b) => a.time - b.time)
          .map(
            (item, index) =>
              item.content != "" && {
                from: item.time,
                to:
                  index == data.length - 1
                    ? item.time + 20
                    : data[index + 1].time,
                content: item.content,
              },
          )
          .filter((item) => item),
      };
    },
    decodeFromSRT(input) {
      if (!input) return;
      const data = [];
      let split = input.split("\n\n");
      if (split.length == 1) split = input.split("\r\n\r\n");
      split.forEach((item) => {
        const match = item.match(this.srtReg);
        if (!match) {
          return;
        }
        data.push({
          from:
            (match[1] * 60 * 60 || 0) +
            match[2] * 60 +
            +match[3] +
            match[4] / 1000,
          to:
            (match[5] * 60 * 60 || 0) +
            match[6] * 60 +
            +match[7] +
            match[8] / 1000,
          content: match[9]
            .trim()
            .replace(/{\\.+?}/g, "")
            .replace(/\\N/gi, "\n")
            .replace(/\\h/g, " "),
        });
      });
      return { body: data.sort((a, b) => a.from - b.from) };
    },
    decodeFromASS(input) {
      if (!input) return;
      const data = [];
      let split = input.split("\n");
      split.forEach((line) => {
        const match = line.match(this.assReg);
        if (!match) {
          return;
        }
        data.push({
          from: match[1] * 60 * 60 + match[2] * 60 + +match[3],
          to: match[4] * 60 * 60 + match[5] * 60 + +match[6],
          content: match[7]
            .trim()
            .replace(/{\\.+?}/g, "")
            .replace(/\\N/gi, "\n")
            .replace(/\\h/g, " "),
        });
      });
      return { body: data.sort((a, b) => a.from - b.from) };
    },
  };

  //旧版播放器CC字幕助手...
  const oldPlayerHelper = {
    setting: undefined,
    subtitle: undefined,
    selectedLan: undefined,
    isclosed: true,
    resizeRate: 100,
    configs: {
      color: [
        {
          value: "16777215",
          content:
            '<<span style="color:#FFF;text-shadow: #000 0px 0px 1px">白色</span>',
        },
        {
          value: "16007990",
          content:
            '<<b style="color:#F44336;text-shadow: #000 0px 0px 1px">红色</b>',
        },
        {
          value: "10233776",
          content:
            '<<b style="color:#9C27B0;text-shadow: #000 0px 0px 1px">紫色</b>',
        },
        {
          value: "6765239",
          content:
            '<<b style="color:#673AB7;text-shadow: #000 0px 0px 1px">深紫色</b>',
        },
        {
          value: "4149685",
          content:
            '<<b style="color:#3F51B5;text-shadow: #000 0px 0px 1px">靛青色</b>',
        },
        {
          value: "2201331",
          content:
            '<<b style="color:#2196F3;text-shadow: #000 0px 0px 1px">蓝色</b>',
        },
        {
          value: "240116",
          content:
            '<<b style="color:#03A9F4;text-shadow: #000 0px 0px 1px">亮蓝色</b>',
        },
      ],
      position: [
        { value: "bl", content: "左下角" },
        { value: "bc", content: "底部居中" },
        { value: "br", content: "右下角" },
        { value: "tl", content: "左上角" },
        { value: "tc", content: "顶部居中" },
        { value: "tr", content: "右上角" },
      ],
      shadow: [
        { value: "0", content: "无描边", style: "" },
        {
          value: "1",
          content: "重墨",
          style: `text-shadow: #000 1px 0px 1px, #000 0px 1px 1px, #000 0px -1px 1px,#000 -1px 0px 1px;`,
        },
        {
          value: "2",
          content: "描边",
          style: `text-shadow: #000 0px 0px 1px, #000 0px 0px 1px, #000 0px 0px 1px;`,
        },
        {
          value: "3",
          content: "45°投影",
          style: `text-shadow: #000 1px 1px 2px, #000 0px 0px 1px;`,
        },
      ],
    },
    saveSetting() {
      try {
        const playerSetting = localStorage.bilibili_player_settings
          ? JSON.parse(localStorage.bilibili_player_settings)
          : {};
        playerSetting.subtitle = this.setting;
        localStorage.bilibili_player_settings = JSON.stringify(playerSetting);
      } catch (e) {
        bilibiliCCHelper.toast("保存字幕设置错误", e);
      }
    },
    changeStyle() {
      this.fontStyle.innerHTML =
        `span.subtitle-item-background{opacity: ${this.setting.backgroundopacity};}` +
        `span.subtitle-item-text {color:#${("000000" + this.setting.color.toString(16)).slice(-6)};}` +
        `span.subtitle-item {font-size: ${this.setting.fontsize * this.resizeRate}%;line-height: 110%;}` +
        `span.subtitle-item {${this.configs.shadow[this.setting.shadow].style}}`;
    },
    changePosition() {
      this.subtitleContainer.className =
        "subtitle-position subtitle-position-" +
        (this.setting.position || "bc");
      this.subtitleContainer.style = "";
    },
    changeResize() {
      this.resizeRate = this.setting.scale
        ? (bilibiliCCHelper.window.player.getWidth() / 1280) * 100
        : 100;
      this.changeStyle();
    },
    changeSubtitle(value = this.subtitle.subtitles[0].lan) {
      this.selectedLanguage.innerText =
        bilibiliCCHelper.getSubtitleInfo(value).lan_doc;
      if (value == "close") {
        if (!this.isclosed) {
          this.isclosed = true;
          bilibiliCCHelper.loadSubtitle(value);
          if (this.selectedLan != "local") this.setting.isclosed = true;
        }
        this.downloadBtn.classList.add(
          "bpui-state-disabled",
          "bpui-button-icon",
        );
        this.icon.innerHTML = elements.oldDisableIcon;
      } else if (value == "local") {
        decoder.show((status) => {
          if (status == true) {
            this.downloadBtn.classList.remove(
              "bpui-state-disabled",
              "bpui-button-icon",
            );
            this.isclosed = false;
            this.selectedLan = value;
            this.icon.innerHTML = elements.oldEnableIcon;
          }
        });
      } else {
        this.isclosed = false;
        this.selectedLan = value;
        this.icon.innerHTML = elements.oldEnableIcon;
        this.setting.lan = value;
        this.setting.isclosed = false;
        bilibiliCCHelper.loadSubtitle(value);
        this.downloadBtn.classList.remove(
          "bpui-state-disabled",
          "bpui-button-icon",
        );
      }
    },
    toggleSubtitle() {
      if (this.isclosed) {
        this.changeSubtitle(this.selectedLan);
      } else {
        this.changeSubtitle("close");
      }
    },
    initSubtitle() {
      if (this.setting.isclosed) {
        this.changeSubtitle("close");
      } else {
        const lan =
          bilibiliCCHelper.getSubtitleInfo(this.setting.lan) &&
          this.setting.lan;
        this.changeSubtitle(lan);
      }
      if (!this.subtitle.count) this.selectedLan = "local";
      this.changeResize();
    },
    initUI() {
      const preBtn = elements.getAs(".bilibili-player-video-btn-quality");
      if (!preBtn) throw "没有找到视频清晰度按钮";
      this.subtitleContainer = elements.getAs(
        ".bilibili-player-video-subtitle>div",
      );
      const btn = preBtn.insertAdjacentElement(
        "afterEnd",
        elements.createAs("div", {
          className: "bilibili-player-video-btn",
          id: "bilibili-player-subtitle-btn",
          style: "display: block;",
          innerHTML: elements.subtitleStyle,
          onclick: (e) => {
            if (!this.panel.contains(e.target)) this.toggleSubtitle();
          },
        }),
      );
      this.icon = elements.createAs(
        "span",
        {
          innerHTML: this.setting.isclosed
            ? elements.oldDisableIcon
            : elements.oldEnableIcon,
        },
        btn,
      );
      this.fontStyle = elements.createAs("style", { type: "text/css" }, btn);
      const panel = (this.panel = elements.createAs(
          "div",
          {
            id: "subtitle-setting-panel",
            style:
              "position: absolute;bottom: 28px;right: 30px;background: white;border-radius: 4px;text-align: left;padding: 13px;display: none;cursor:default;",
          },
          btn,
        )),
        languageDiv = elements.createAs(
          "div",
          { innerHTML: "<<div>字幕</div>" },
          panel,
        ),
        sizeDiv = elements.createAs(
          "div",
          { innerHTML: "<<div>字体大小</div>" },
          panel,
        ),
        colorDiv = elements.createAs(
          "div",
          { innerHTML: "<<span>字幕颜色</span>" },
          panel,
        ),
        shadowDiv = elements.createAs(
          "div",
          { innerHTML: "<<span>字幕描边</span>" },
          panel,
        ),
        positionDiv = elements.createAs(
          "div",
          { innerHTML: "<<span>字幕位置</span>" },
          panel,
        ),
        opacityDiv = elements.createAs(
          "div",
          { innerHTML: "<<div>背景不透明度</div>" },
          panel,
        );
      this.selectedLanguage = elements.createSelector(
        {
          width: "100px",
          height: "180px",
          initValue: "close",
          handler: (value) => this.changeSubtitle(value),
          datas: this.subtitle.subtitles.map(({ lan, lan_doc }) => ({
            content: lan_doc,
            value: lan,
          })),
        },
        languageDiv,
      );
      this.downloadBtn = elements.createAs(
        "button",
        {
          className: "bpui-button",
          style: "padding:0 8px;",
          innerText: "下载",
          onclick: (ev) => {
            if (this.selectedLan == "close") return;
            bilibiliCCHelper.downloadSubtitle(
              this.selectedLan,
              undefined,
              ev.ctrlKey,
            );
          },
        },
        languageDiv,
      );
      elements.createAs(
        "a",
        {
          className: this.subtitle.allow_submit
            ? "bpui-button"
            : "bpui-button bpui-state-disabled",
          innerText: "添加字幕",
          href: !this.subtitle.allow_submit
            ? "javascript:"
            : `https://member.bilibili.com/v2#/zimu/my-zimu/zimu-editor?cid=${window.cid}&${window.aid ? `aid=${window.aid}` : `bvid=${window.bvid}`}`,
          target: "_blank",
          style: "margin-right: 0px;height: 24px;padding:0 6px;",
          title: this.subtitle.allow_submit ? "" : "本视频无法添加字幕",
        },
        languageDiv,
      );
      elements.createAs(
        "input",
        {
          style: "width: 70%;",
          type: "range",
          step: "25",
          value:
            this.setting.fontsize == 0.6
              ? 0
              : this.setting.fontsize == 0.8
                ? 25
                : this.setting.fontsize == 1.3
                  ? 75
                  : this.setting.fontsize == 1.6
                    ? 100
                    : 50,
          oninput: (e) => {
            const v = e.target.value / 25;
            this.setting.fontsize = v > 2 ? (v - 2) * 0.3 + 1 : v * 0.2 + 0.6;
            this.changeStyle();
          },
        },
        sizeDiv,
      );
      elements.createAs(
        "input",
        {
          id: "subtitle-auto-resize",
          type: "checkbox",
          checked: this.setting.scale,
          onchange: (e) =>
            this.changeResize((this.setting.scale = e.target.checked)),
        },
        sizeDiv,
      );
      elements
        .createAs(
          "label",
          {
            style: "cursor:pointer",
            innerText: "自动缩放",
          },
          sizeDiv,
        )
        .setAttribute("for", "subtitle-auto-resize");
      elements.createSelector(
        {
          width: "74%",
          height: "120px",
          initValue: this.setting.color,
          handler: (value) =>
            this.changeStyle((this.setting.color = parseInt(value))),
          datas: this.configs.color,
        },
        colorDiv,
      );
      elements.createSelector(
        {
          width: "74%",
          height: "120px",
          initValue: this.setting.shadow,
          handler: (value) => this.changeStyle((this.setting.shadow = value)),
          datas: this.configs.shadow,
        },
        shadowDiv,
      );
      elements.createSelector(
        {
          width: "74%",
          initValue: this.setting.position,
          handler: (value) =>
            this.changePosition((this.setting.position = value)),
          datas: this.configs.position,
        },
        positionDiv,
      );
      elements.createAs(
        "input",
        {
          style: "width: 100%;",
          type: "range",
          value: this.setting.backgroundopacity * 100,
          oninput: (e) => {
            this.changeStyle(
              (this.setting.backgroundopacity = e.target.value / 100),
            );
          },
        },
        opacityDiv,
      );
      bilibiliCCHelper.window.player.addEventListener(
        "video_resize",
        (event) => {
          this.changeResize(event);
        },
      );
      bilibiliCCHelper.window.addEventListener("beforeunload", (event) => {
        this.saveSetting();
      });
      this.initSubtitle();
      console.log("init cc helper button done");
    },
    init(subtitle) {
      this.subtitle = subtitle;
      this.selectedLan = undefined;
      try {
        if (!localStorage.bilibili_player_settings)
          throw "当前播放器没有设置信息";
        this.setting = JSON.parse(
          localStorage.bilibili_player_settings,
        ).subtitle;
        if (!this.setting) throw "当前播放器没有字幕设置";
      } catch (e) {
        bilibiliCCHelper.toast(
          "bilibili CC字幕助手读取设置出错,将使用默认设置:",
          e,
        );
        this.setting = {
          backgroundopacity: 0.5,
          color: 16777215,
          fontsize: 1,
          isclosed: false,
          scale: true,
          shadow: "0",
          position: "bc",
        };
      }
      this.initUI();
    },
  };

  //2.x播放器CC字幕助手...
  const player2x = {
    iconBtn: undefined,
    icon: undefined,
    panel: undefined,
    downloadBtn: undefined,
    selectedLan: undefined,
    selectedLocal: false,
    hasSubtitles: false,
    updateDownloadBtn(value = "close") {
      this.selectedLan = value;
      if (value == "close") {
        this.downloadBtn.classList.add(
          "bui-button-disabled",
          "bpui-button-icon",
        );
      } else {
        this.selectedLocal = false;
        this.downloadBtn.classList.remove(
          "bui-button-disabled",
          "bpui-button-icon",
        );
      }
    },
    initUI() {
      const downloadBtn = (this.downloadBtn =
          this.panel.nextElementSibling.cloneNode()),
        selector = this.panel.querySelector("ul"),
        selectedItem = selector.querySelector(
          "li.bui-select-item.bui-select-item-active",
        ),
        closeItem = selector.querySelector(
          'li.bui-select-item[data-value="close"]',
        ),
        localItem = closeItem.cloneNode();
      elements.setAs(downloadBtn, {
        style: "min-width:unset!important",
        innerText: "下载",
        onclick: (ev) => {
          if (this.selectedLan == "close") return;
          bilibiliCCHelper.downloadSubtitle(
            this.selectedLan,
            undefined,
            ev.ctrlKey,
          );
        },
      });
      this.panel.insertAdjacentElement("afterend", downloadBtn);
      this.updateDownloadBtn(selectedItem && selectedItem.dataset.value);
      elements.setAs(
        localItem,
        {
          innerText: "本地字幕",
          onclick: () => {
            decoder.show((status) => {
              if (status == true) {
                this.selectedLocal = true;
                this.updateDownloadBtn("local");
                this.icon.innerHTML = elements.newEnableIcon;
              }
            });
          },
        },
        selector,
      );
      closeItem.addEventListener("click", () => {
        if (!this.selectedLocal) return;
        this.selectedLocal = false;
        bilibiliCCHelper.loadSubtitle("close");
        this.icon.innerHTML = elements.newDisableIcon;
      });
      if (!this.hasSubtitles && this.icon) {
        this.icon.innerHTML = elements.newDisableIcon;
        this.icon.addEventListener("click", ({ target }) => {
          if (!this.selectedLocal) localItem.click();
          else closeItem.click();
        });
      }
      new MutationObserver((mutations, observer) => {
        mutations.forEach((mutation) => {
          if (!mutation.target || mutation.type != "attributes") return;
          if (
            mutation.target.classList.contains("bui-select-item-active") &&
            mutation.target.dataset.value
          ) {
            this.updateDownloadBtn(mutation.target.dataset.value);
          }
        });
      }).observe(selector, {
        subtree: true,
        attributes: true,
        attributeFilter: ["class"],
      });
      console.log("Bilibili CC Helper init new UI success.");
    },
    initUI275() {
      if (
        (this.localPanel = this.panel.querySelector(
          ".bilibili-player-video-subtitle-setting-item-body",
        ))
      ) {
        if (
          !(this.localButton = this.localPanel.querySelector(
            ".bilibili-player-video-subtitle-setting-title",
          ))
        ) {
          this.localPanel.insertAdjacentElement(
            "afterbegin",
            elements.createAs("div", {
              innerText: "字幕",
              className: "bilibili-player-video-subtitle-setting-title",
              onclick: () =>
                decoder.show(
                  (status) =>
                    status && (this.icon.innerHTML = elements.newEnableIcon),
                ),
            }),
          );
        } else {
          this.localButton.onclick = () =>
            decoder.show((status) => {
              if (status) {
                this.selectedLocal = true;
                this.icon.innerHTML = elements.newEnableIcon;
              }
            });
        }
      }
      if (
        (this.lngPanel = this.panel.querySelector(
          ".bilibili-player-video-subtitle-setting-lan-majorlist",
        ))
      ) {
        this.lngPanel.addEventListener("click", function (ev) {
          if (
            !(ev.target instanceof HTMLLIElement) ||
            ev.target.lastChild.data == "本地字幕"
          )
            return;
          const rect = ev.target.getBoundingClientRect().right;
          if (rect == 0 || rect - ev.x > 30) return;
          bilibiliCCHelper.downloadSubtitle(
            undefined,
            ev.target.lastChild.data,
            ev.ctrlKey,
          );
          return false;
        });
      }
      elements.createAs(
        "style",
        {
          innerHTML:
            '.bilibili-player-video-subtitle-setting-lan-majorlist>li.bilibili-player-video-subtitle-setting-lan-majorlist-item:after {content: "下载";right: 12px;position: absolute;}' +
            '.bilibili-player-video-subtitle-setting-title {cursor:pointer}.bilibili-player-video-subtitle-setting-title:before {content: "本地"}',
        },
        this.panel,
      );
      if (!this.hasSubtitles) {
        this.icon.onclick = () => {
          if (this.selectedLocal) {
            this.selectedLocal = false;
            bilibiliCCHelper.loadSubtitle("close");
            this.icon.innerHTML = elements.newDisableIcon;
          } else {
            this.localButton.click();
          }
        };
        this.icon.innerHTML = elements.newDisableIcon;
      }
      console.log("Bilibili CC Helper init new 2.75 UI success.");
    },
    init(subtitle) {
      this.hasSubtitles = subtitle.count;
      this.selectedLan = undefined;
      this.selectedLocal = false;
      this.iconBtn = elements.getAs(".bilibili-player-video-btn-subtitle");
      this.panel = elements.getAs(
        ".bilibili-player-video-subtitle-setting-lan",
      );
      this.icon = this.iconBtn.querySelector(
        ".bilibili-player-iconfont-subtitle span",
      );
      elements.createAs(
        "style",
        { innerHTML: ".bilibili-player-video-subtitle {z-index: 20;}" },
        document.head,
      );
      if (this.panel) {
        this.initUI();
        this.iconBtn.id = "bilibili-player-subtitle-btn";
      } else if (this.iconBtn) {
        this.iconBtn.style = "display:block";
        if (!this.hasSubtitles && this.icon)
          this.icon.innerHTML = elements.newDisableIcon;
        this.iconBtn.id = "bilibili-player-subtitle-btn";
        new MutationObserver((mutations, observer) => {
          for (const mutation of mutations) {
            if (!mutation.target) continue;
            if (
              mutation.target.classList.contains(
                "bilibili-player-video-subtitle-setting-left",
              )
            ) {
              observer.disconnect();
              if (
                (this.panel = mutation.target.querySelector(
                  ".bilibili-player-video-subtitle-setting-lan",
                ))
              ) {
                this.initUI();
              } else {
                this.panel = mutation.target;
                this.initUI275();
              }
              return;
            }
          }
        }).observe(this.iconBtn, {
          childList: true,
          subtree: true,
        });
      } else {
        throw "找不到新播放器按钮";
      }
    },
  };

  // 3.15新版播放器...
  const player315 = {
    panel: undefined,
    initUI() {
      elements.createAs(
        "style",
        {
          innerHTML:
            '.bpx-player-ctrl-subtitle-major-inner>.bpx-player-ctrl-subtitle-language-item:after {content: "下载";position:absolute;right:12px; margin-top:12px;}',
        },
        this.panel,
      );
      this.panel.addEventListener(
        "click",
        function (ev) {
          if (
            !ev.target ||
            !ev.target.classList.contains(
              "bpx-player-ctrl-subtitle-language-item",
            )
          )
            return;
          const rect = ev.target.getBoundingClientRect().right;
          if (rect == 0 || rect - ev.x > 30) return;
          ev.preventDefault();
          ev.stopPropagation();
          bilibiliCCHelper.downloadSubtitle(
            ev.target.dataset.lan,
            ev.target.lastChild.data,
            ev.ctrlKey,
          );
          return false;
        },
        true,
      );
      this.panel.id = "bilibili-player-subtitle-btn";
      console.log("3.15 Bilibili CC Helper init new Bangumi UI success.");
    },
    init(subtitle) {
      this.panel = elements.getAs(".bpx-player-ctrl-subtitle-major-content");
      if (!this.panel) {
        throw "无字幕";
      }
      this.initUI();
    },
  };

  //3.14版番剧播放器...
  const player314 = {
    iconBtn: undefined,
    icon: undefined,
    panel: undefined,
    selectedLan: undefined,
    selectedLocal: false,
    hasSubtitles: false,
    updateBtnIcon(value) {
      if (value) {
        this.icon.classList.add("squirtle-subtitle-show-state");
        this.icon.classList.remove("squirtle-subtitle-hide-state");
      } else {
        this.icon.classList.add("squirtle-subtitle-hide-state");
        this.icon.classList.remove("squirtle-subtitle-show-state");
      }
    },
    initUI() {
      elements.createAs(
        "style",
        {
          innerHTML:
            '.squirtle-subtitle-select-list>li.squirtle-select-item:after {content: "下载";}',
        },
        document.head,
      );
      this.panel.addEventListener("click", function (ev) {
        if (!(ev.target instanceof HTMLLIElement)) return;
        const rect = ev.target.getBoundingClientRect().right;
        if (rect == 0 || rect - ev.x > 30) return;
        const subtitleName = ev.target.lastChild.data;
        bilibiliCCHelper
          .getSubtitle(undefined, subtitleName)
          .then((data) => {
            const item = bilibiliCCHelper.getSubtitleInfo(
              undefined,
              subtitleName,
            );
            encoder.showDialog(data, ev.ctrlKey, item && item.lan);
          })
          .catch((e) => {
            bilibiliCCHelper.toast("获取字幕失败", e);
          });
        return false;
      });
      this.panel.id = "bilibili-player-subtitle-btn";
      console.log("Bilibili CC Helper init new Bangumi UI success.");
    },
    init(subtitle) {
      this.hasSubtitles = subtitle.count;
      this.selectedLan = undefined;
      this.selectedLocal = false;
      this.iconBtn = elements.getAs(".squirtle-subtitle-wrap");
      this.panel = elements.getAs(".squirtle-subtitle-select-list");
      this.icon = this.iconBtn.querySelector(".squirtle-subtitle-icon");
      if (!this.iconBtn) {
        throw "找不到新播放器按钮";
      }
      if (this.panel) this.initUI();
    },
  };

  //启动器
  const bilibiliCCHelper = {
    window: "undefined" == typeof unsafeWindow ? window : unsafeWindow,
    player: undefined,
    cid: undefined,
    subtitle: undefined,
    datas: undefined,
    menuCommandsRegistered: false,
    floatButton: null,
    floatButtonHiddenThisPage: false,
    floatButtonPrefKey: "bilibili_cc_float_button_hidden_v1",
    // 【需求 1】DeepSeek 官方小鲸鱼图标
    // 路径直接取自 https://fe-static.deepseek.com/chat/favicon.svg
    // viewBox 是 0 0 24 24，fill="currentColor" 会自动继承按钮的 color:#fff，
    // 在蓝色渐变背景上呈现为一只白色鲸鱼，和 DeepSeek 官网 logo 一致。
    DEEPSEEK_WHALE_SVG:
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" ' +
      'fill-rule="evenodd" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"></path>' +
      "</svg>",
    registerMenuCommands() {
      if (
        this.menuCommandsRegistered ||
        typeof GM_registerMenuCommand !== "function"
      )
        return;
      this.menuCommandsRegistered = true;
      GM_registerMenuCommand("打开字幕下载窗口", () =>
        this.openDownloadDialog(),
      );
      GM_registerMenuCommand("批量下载字幕", () => this.openBatchDialog());
      GM_registerMenuCommand("打开/关闭悬浮按钮（全局设置）", () =>
        this.toggleFloatingButtonGlobal(),
      );
    },

    // =========================================================
    // 【需求 1/2/3】悬浮按钮群：
    //   ① 字幕批量下载（原 ⭐ 按钮，变量名 floatButton → subtitleBatchButton）
    //   ② 一键复制 SRT（原功能）
    //   ③ 复制标准视频链接
    //   ④ 复制 Markdown 链接
    //   ⑤ 发送到 DeepSeek（原功能）
    // =========================================================
    createFloatingButton() {
      // 【改进点 6】等 DOM 就绪：
      //   原条件是 `if (this.floatButton || !document.body) return;`
      //   如果脚本在 <head> 里抢先执行、document.body 尚不存在，
      //   这里会直接 return 且之后再无重试，悬浮按钮永远不出现。
      //   现在改为等 DOMContentLoaded 或轮询重试。
      if (this.subtitleBatchButton) return;
      if (!document.body) {
        if (document.readyState === "loading") {
          document.addEventListener(
            "DOMContentLoaded",
            () => this.createFloatingButton(),
            { once: true },
          );
        } else {
          setTimeout(() => this.createFloatingButton(), 100);
        }
        return;
      }
      const self = this;

      // 外层容器（按钮竖向排列）
      this.floatButtonContainer = elements.createAs(
        "div",
        {
          id: "cc-subtitle-float-container",
          style:
            "position:fixed;top:110px;right:24px;z-index:1048577;" +
            "display:flex;flex-direction:column;gap:8px;",
        },
        document.body,
      );

      // 【需求 1】字幕批量下载（原 ⭐ 按钮）
      this.subtitleBatchButton = elements.createAs(
        "div",
        {
          id: "cc-subtitle-batch-trigger",
          style:
            "width:44px;height:44px;background:linear-gradient(135deg,#00a1d6,#00b5e5);" +
            "border-radius:12px;box-shadow:0 4px 14px rgba(0,161,214,0.35);cursor:pointer;" +
            "display:flex;align-items:center;justify-content:center;color:#fff;" +
            "user-select:none;-webkit-tap-highlight-color:transparent;" +
            "transition:transform .15s, box-shadow .15s;",
          innerHTML:
            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
            'stroke-linejoin="round">' +
            '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
            '<polyline points="7 10 12 15 17 10"/>' +
            '<line x1="12" y1="15" x2="12" y2="3"/>' +
            "</svg>",
          title: "字幕批量下载 — 左键打开，右键设置",
          onmouseenter: function () {
            this.style.transform = "scale(1.1)";
            this.style.boxShadow = "0 6px 20px rgba(0,161,214,0.55)";
          },
          onmouseleave: function () {
            this.style.transform = "scale(1)";
            this.style.boxShadow = "0 4px 14px rgba(0,161,214,0.35)";
          },
          onclick: function () {
            self.openDownloadDialog();
          },
          oncontextmenu: function (e) {
            e.preventDefault();
            e.stopPropagation();
            self.showFloatingButtonMenu(e.clientX, e.clientY);
            return false;
          },
        },
        this.floatButtonContainer,
      );

      // 一键复制 SRT 字幕（原功能）
      this.copyFloatButton = elements.createAs(
        "div",
        {
          id: "cc-subtitle-copy-trigger",
          style:
            "width:44px;height:44px;background:linear-gradient(135deg,#20b26b,#27c97a);" +
            "border-radius:12px;box-shadow:0 4px 14px rgba(32,178,107,0.35);cursor:pointer;" +
            "display:flex;align-items:center;justify-content:center;color:#fff;" +
            "user-select:none;-webkit-tap-highlight-color:transparent;" +
            "transition:transform .15s, box-shadow .15s;",
          innerHTML:
            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
            'stroke-linejoin="round">' +
            '<rect x="9" y="9" width="11" height="11" rx="2"/>' +
            '<path d="M5 15V5a2 2 0 0 1 2-2h10"/>' +
            "</svg>",
          title: "一键复制当前视频的 SRT 字幕",
          onmouseenter: function () {
            this.style.transform = "scale(1.1)";
            this.style.boxShadow = "0 6px 20px rgba(32,178,107,0.55)";
          },
          onmouseleave: function () {
            this.style.transform = "scale(1)";
            this.style.boxShadow = "0 4px 14px rgba(32,178,107,0.35)";
          },
          onclick: function () {
            self.copyCurrentSubtitleSRT(this);
          },
        },
        this.floatButtonContainer,
      );

      // 【需求 2】复制标准视频链接
      this.copyLinkButton = elements.createAs(
        "div",
        {
          id: "cc-copy-link-trigger",
          style:
            "width:44px;height:44px;background:linear-gradient(135deg,#ff9800,#ffb74d);" +
            "border-radius:12px;box-shadow:0 4px 14px rgba(255,152,0,0.35);cursor:pointer;" +
            "display:flex;align-items:center;justify-content:center;color:#fff;" +
            "user-select:none;-webkit-tap-highlight-color:transparent;" +
            "transition:transform .15s, box-shadow .15s;",
          innerHTML:
            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
            'stroke-linejoin="round">' +
            '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
            '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' +
            "</svg>",
          title: "复制当前视频的标准链接",
          onmouseenter: function () {
            this.style.transform = "scale(1.1)";
            this.style.boxShadow = "0 6px 20px rgba(255,152,0,0.55)";
          },
          onmouseleave: function () {
            this.style.transform = "scale(1)";
            this.style.boxShadow = "0 4px 14px rgba(255,152,0,0.35)";
          },
          onclick: function () {
            self.copyVideoLink(this);
          },
        },
        this.floatButtonContainer,
      );

      // 【需求 3】复制 Markdown 链接
      // 图标 = 链条链接图标（主） + 右下角 MD 徽标（辅）
      this.copyMdLinkButton = elements.createAs(
        "div",
        {
          id: "cc-copy-md-link-trigger",
          style:
            "width:44px;height:44px;background:linear-gradient(135deg,#9c27b0,#b968c7);" +
            "border-radius:12px;box-shadow:0 4px 14px rgba(156,39,176,0.35);cursor:pointer;" +
            "display:flex;align-items:center;justify-content:center;color:#fff;" +
            "position:relative;" +
            "user-select:none;-webkit-tap-highlight-color:transparent;" +
            "transition:transform .15s, box-shadow .15s;",
          innerHTML:
            // 主图标：链条（link）——两段环扣，一眼看出"复制链接"
            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" ' +
            'stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
            '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' +
            "</svg>" +
            // 右下角徽标：白底紫字 "MD"，与按钮背景形成对比
            '<span style="position:absolute;bottom:2px;right:2px;' +
            "font-size:8px;font-weight:700;line-height:11px;letter-spacing:-0.2px;" +
            "background:#fff;color:#9c27b0;padding:0 3px;border-radius:5px;" +
            'box-shadow:0 1px 3px rgba(0,0,0,0.25);">MD</span>',
          title: "复制为 Markdown 链接：[标题](链接)",
          onmouseenter: function () {
            this.style.transform = "scale(1.1)";
            this.style.boxShadow = "0 6px 20px rgba(156,39,176,0.55)";
          },
          onmouseleave: function () {
            this.style.transform = "scale(1)";
            this.style.boxShadow = "0 4px 14px rgba(156,39,176,0.35)";
          },
          onclick: function () {
            self.copyVideoLinkMarkdown(this);
          },
        },
        this.floatButtonContainer,
      );

      // 发送到 DeepSeek（原功能）
      this.deepseekFloatButton = elements.createAs(
        "div",
        {
          id: "cc-subtitle-deepseek-trigger",
          style:
            "width:44px;height:44px;background:linear-gradient(135deg,#4d6bfe,#6b83ff);" +
            "border-radius:12px;box-shadow:0 4px 14px rgba(77,107,254,0.35);cursor:pointer;" +
            "display:flex;align-items:center;justify-content:center;color:#fff;" +
            "font-weight:700;font-size:15px;letter-spacing:.5px;font-family:Arial,sans-serif;" +
            "user-select:none;-webkit-tap-highlight-color:transparent;" +
            "transition:transform .15s, box-shadow .15s;",
          innerHTML: this.DEEPSEEK_WHALE_SVG,
          title: "把当前视频的字幕发送给 DeepSeek，自动整理成 Obsidian 笔记",
          onmouseenter: function () {
            this.style.transform = "scale(1.1)";
            this.style.boxShadow = "0 6px 20px rgba(77,107,254,0.55)";
          },
          onmouseleave: function () {
            this.style.transform = "scale(1)";
            this.style.boxShadow = "0 4px 14px rgba(77,107,254,0.35)";
          },
          onclick: function () {
            self.sendSubtitleToDeepSeek(this);
          },
        },
        this.floatButtonContainer,
      );

      // 【需求 2】发送字幕到 DeepSeek（带时间戳版）
      // 与上面那个按钮功能相同，但会：
      //   ① 把字幕转成 "[MM:SS] 内容" 的带时间戳格式
      //   ② 在提示词里追加一条要求，让 DeepSeek 在笔记里也标注时间戳
      // 视觉上用更深的蓝 + 右下角一个黄色 T 徽标，与"不标时间戳"版本区分。
      this.deepseekTimestampButton = elements.createAs(
        "div",
        {
          id: "cc-subtitle-deepseek-ts-trigger",
          style:
            "width:44px;height:44px;background:linear-gradient(135deg,#2b3cc9,#4d6bfe);" +
            "border-radius:12px;box-shadow:0 4px 14px rgba(43,60,201,0.4);cursor:pointer;" +
            "display:flex;align-items:center;justify-content:center;color:#fff;" +
            "position:relative;" +
            "user-select:none;-webkit-tap-highlight-color:transparent;" +
            "transition:transform .15s, box-shadow .15s;",
          innerHTML:
            this.DEEPSEEK_WHALE_SVG +
            '<span style="position:absolute;bottom:2px;right:3px;' +
            "font-size:9px;font-weight:700;background:#ffd54f;color:#1e2f9c;" +
            'padding:0 3px;border-radius:6px;line-height:12px;">T</span>',
          title: "把字幕发送给 DeepSeek，并在笔记中标注时间戳，方便回看视频",
          onmouseenter: function () {
            this.style.transform = "scale(1.1)";
            this.style.boxShadow = "0 6px 20px rgba(43,60,201,0.6)";
          },
          onmouseleave: function () {
            this.style.transform = "scale(1)";
            this.style.boxShadow = "0 4px 14px rgba(43,60,201,0.4)";
          },
          onclick: function () {
            self.sendSubtitleToDeepSeekWithTimestamps(this);
          },
        },
        this.floatButtonContainer,
      );

      this.applyFloatingButtonVisibility();
    },

    applyFloatingButtonVisibility() {
      if (!this.floatButtonContainer) return;
      const state = uiManager.loadState(this.floatButtonPrefKey, {
        hidden: false,
      });
      this.floatButtonContainer.style.display =
        this.floatButtonHiddenThisPage || state.hidden ? "none" : "flex";
    },
    toggleFloatingButtonGlobal() {
      const state = uiManager.loadState(this.floatButtonPrefKey, {
        hidden: false,
      });
      uiManager.saveState(this.floatButtonPrefKey, { hidden: !state.hidden });
      this.floatButtonHiddenThisPage = false;
      this.applyFloatingButtonVisibility();
      this.toast(state.hidden ? "悬浮按钮已打开" : "悬浮按钮已关闭");
    },
    hideFloatingButtonTemporarily() {
      this.floatButtonHiddenThisPage = true;
      this.applyFloatingButtonVisibility();
      this.toast("悬浮按钮已临时关闭");
    },
    hideFloatingButtonPermanently() {
      uiManager.saveState(this.floatButtonPrefKey, { hidden: true });
      this.floatButtonHiddenThisPage = true;
      this.applyFloatingButtonVisibility();
      this.toast("悬浮按钮已永久关闭，可从插件菜单重新打开");
    },
    async copyCurrentSubtitleSRT(btn) {
      if (btn) {
        btn.style.pointerEvents = "none";
        btn.style.opacity = "0.65";
      }
      try {
        encoder.showToast("正在获取字幕…");

        const subtitle = await this.setupData();
        if (!subtitle) throw "当前页面还没有读取到视频信息";

        const languages = (subtitle.subtitles || []).filter(
          (item) => item.lan !== "close" && item.lan !== "local",
        );
        if (!languages.length) throw "当前视频没有可用的在线字幕";

        // 优先使用上次在下拉框里选过的语言
        const lan =
          encoder.currentLan &&
          languages.some((item) => item.lan === encoder.currentLan)
            ? encoder.currentLan
            : languages[0].lan;

        const data = await this.getSubtitle(lan);
        if (!data || !Array.isArray(data.body) || !data.body.length)
          throw "字幕内容为空";

        const srt = encoder.encodeToSRT(data.body);
        const ok = await this.copyTextToClipboard(srt);
        if (!ok) throw "浏览器拒绝了剪贴板访问";

        encoder.showToast(`✅ 已复制 SRT 字幕（${data.body.length} 条）`);
      } catch (e) {
        console.error("复制字幕失败", e);
        encoder.showToast(`❌ 复制失败：${e}`, "error");
      } finally {
        if (btn) {
          btn.style.pointerEvents = "";
          btn.style.opacity = "";
        }
      }
    },

    // =========================================================
    // 【需求 2】标准化视频链接
    // 规则：
    //   普通视频 → https://www.bilibili.com/video/BVxxx（多P时带 ?p=N）
    //   番剧     → https://www.bilibili.com/bangumi/play/epxxxx / ssxxxx
    //   课程     → https://www.bilibili.com/cheese/play/epxxxx / ssxxxx
    //   其它页面 → 用 origin + pathname 兜底
    // =========================================================
    getStandardVideoUrl() {
      const pathname = location.pathname;
      const search = location.search;

      // 番剧 / 课程 单集：ep
      let m = pathname.match(/\/(bangumi|cheese)\/play\/ep(\d+)/i);
      if (m) {
        return `https://www.bilibili.com/${m[1].toLowerCase()}/play/ep${m[2]}`;
      }

      // 番剧 / 课程 整季：ss
      m = pathname.match(/\/(bangumi|cheese)\/play\/ss(\d+)/i);
      if (m) {
        return `https://www.bilibili.com/${m[1].toLowerCase()}/play/ss${m[2]}`;
      }

      // 普通视频：从 path、query、页面数据里依次尝试拿到 bvid
      const params = new URLSearchParams(search);
      const bvid =
        (pathname.match(/\/video\/(BV[0-9A-Za-z]+)/) || [])[1] ||
        params.get("bvid") ||
        this.getInfo("bvid") ||
        this.bvid;

      if (bvid) {
        // 多P视频带上当前分P
        let p = this.window && this.window.__INITIAL_STATE__?.p;
        if (!p) p = +(params.get("p") || 1);
        return (
          `https://www.bilibili.com/video/${bvid}` + (p > 1 ? `?p=${p}` : "")
        );
      }

      // 兜底：不认识的页面，直接给 origin + pathname，避免带一堆追踪参数
      return location.origin + pathname;
    },

    // 取一个干净的视频标题（去掉“_哔哩哔哩_bilibili”这类后缀）
    getCleanTitle() {
      let title =
        this.getInfo("h1Title") ||
        this.window?.__INITIAL_STATE__?.videoData?.title ||
        this.window?.__INITIAL_STATE__?.epInfo?.title ||
        document.title ||
        "";
      title = String(title)
        .replace(/[_\-|]\s*(哔哩哔哩|bilibili).*$/i, "")
        .trim();
      return title || "视频";
    },

    // 【需求 2】复制标准视频链接
    async copyVideoLink(btn) {
      if (btn) {
        btn.style.pointerEvents = "none";
        btn.style.opacity = "0.65";
      }
      try {
        const url = this.getStandardVideoUrl();
        if (!url) throw "无法获取视频链接";
        const ok = await this.copyTextToClipboard(url);
        if (!ok) throw "浏览器拒绝了剪贴板访问";
        encoder.showToast("✅ 已复制视频链接");
      } catch (e) {
        console.error("复制视频链接失败", e);
        encoder.showToast(`❌ 复制失败：${e}`, "error");
      } finally {
        if (btn) {
          btn.style.pointerEvents = "";
          btn.style.opacity = "";
        }
      }
    },

    // 【需求 3】复制 Markdown 链接 [标题](链接)
    async copyVideoLinkMarkdown(btn) {
      if (btn) {
        btn.style.pointerEvents = "none";
        btn.style.opacity = "0.65";
      }
      try {
        const url = this.getStandardVideoUrl();
        if (!url) throw "无法获取视频链接";
        const title = this.getCleanTitle();
        const text = `[${title}](${url})`;
        const ok = await this.copyTextToClipboard(text);
        if (!ok) throw "浏览器拒绝了剪贴板访问";
        encoder.showToast("✅ 已复制 Markdown 链接");
      } catch (e) {
        console.error("复制 Markdown 链接失败", e);
        encoder.showToast(`❌ 复制失败：${e}`, "error");
      } finally {
        if (btn) {
          btn.style.pointerEvents = "";
          btn.style.opacity = "";
        }
      }
    },

    // ==================== Obsidian 笔记 SKILL ====================
    OBSIDIAN_SKILL_PROMPT: `你是一个帮助用户整理视频内容的助手。用户会给你一段视频字幕，你需要根据字幕总结视频内容，写成能直接粘贴进 Obsidian 笔记的 Markdown 正文。

【硬性要求，必须严格遵守】
1. 字幕预处理：
  1. 语音识别问题：由于字幕通常是 AI 识别的，所以可能会有一些问题，例如脑雾被识别成脑物，Trae Work 变成吹work，WorkBuddy 变成 work body。如果你可以肯定字幕一定是写错了，就先更改后再整理。
  2. 翻译问题：部分字幕是翻译自外文的，所以可能有问题，比如 Doom 被翻译成厄运之类的，或者是语句很奇怪，你可以在确保不会产生歧义且不会影响原意的前提下重构句子，让句子变正常。
2. 不要编造字幕里没有的信息；字幕里没提的结论、数据、案例一概不要脑补。
3. 如果字幕里出现专有名词、人名、产品名、命令、代码等，请保持原文写法。
4. 不要向用户提问，不要征询用户意见，只输出成品。
5. 直接输出笔记正文，不要有任何开场白、说明或收尾语，例如"以下是我给你整理的笔记""希望对你有帮助"之类的话一律不要出现。
6. 不要给笔记添加任何标签（Tag），例如 #健身、#Linux、#学习 等一律不要出现；也不要在文末追加标签行。
7. 用中文输出；标题、要点、列表、表格、代码块、Emoji等可以按需使用，以此让层次清晰、笔记易读。


【建议的笔记结构（可灵活裁剪，视内容而定）】
# 概要
- 视频标题
- 视频主题/核心问题（范例：第二故事设计困境、系统叙事、打破规则、开发经验教训）

# 核心内容
- 关键论点 / 知识点
- 最终结论



以下是范例：
# AI 与自媒体：人机协作的实践与思考

> 视频来源：B站 UP主“阿泰”（知识区）
> 主题：AI 时代做视频还需要人吗？如何与 AI 相处？以及字节“吹work AI知识库”实战体验

---

## 一、背景与焦虑

- **现象**：网上大量短剧、直播、美女视频，甚至评论区互动，全部由 AI 生成，真假难辨。
- **AI 内容生产现状**：
  - 文案、配音、画面、剪辑、账号运营均可由 AI 完成。
  - 传统视频制作：写稿 3-4 天，后期剪辑 4 天，复杂片子拍摄 7 天、写稿 3 天、后期 20 天。
  - AI 知识区视频：一个人、一台电脑、一天可生产几十条，质量还不差。
- **UP主的恐慌**：
  - 不用 AI，效率拼不过别人。
  - 用 AI，担心内容变成标准答案，观点平均，人会不会“用废”。

## 二、核心问题：把什么交给 AI，什么留给自己？

- **AI 的本质**：概率计算，从已有信息中找共性，给出最稳妥、不出错的答案。
- **好内容需要**：人的选择、判断、与现有内容的差异。
- **人机协作原则**：
  - **AI 负责扩大可能性、激发问题**。
  - **人负责做出判断、决定相信什么、表达什么**。
  - AI 是站在旁边的“他者”，不是直接给答案的先知。

## 三、Trae Work AI知识库：是什么？

字节跳动旗下官方 AI 知识库，解决“AI 很强但不知道怎么用”的问题。

### 主要内容板块

| 板块 | 内容 |
|---|---|
| 新手入门 | 快速认识 Trae Work：安装、界面布局、三种模式 |
| AI 通识方法论 | 系统讲解 skill、MCP、prompt engineering 等技术名词 |
| 官方功能教程 | 产品基本逻辑与操作方式 |
| 实战指南 | 超 30 份，覆盖教育学习、个人成长、文档写作、数据处理、汇报演示等 7 大工作场景 |
| 工具资源推荐 | skill 推荐与说明，如研发十大 skill、产品经理六大 skill、14 个值得安装的 skill |

- **特点**：免费、持续更新、事无巨细，比网上卖几十上百的 AI 网课更全面系统。

## 四、实战案例

### 1. 选题雷达（找选题 → 筛选题）

- **步骤**：
  1. 让 Trae Work 分析账号和历史视频，总结重点深耕的 5 个行业/领域，给出视频数占比、总播放量（顺手完成账号复盘）。
  2. 生成行业热点日报（覆盖 5 大领域，38 条新闻），按实战指南提示词整理。
  3. 让 AI 总结适合“阿泰”视频的选题判断标准（反直觉、悬念性、争议空间、产业链可拆解、深度数据实测、可支撑性）。
  4. 让 AI 给每个选题打分，筛选出得分最高的 3-5 个，输出标题雏形、一句话钩子、核心矛盾、大众入口、可深挖知识增量。
  5. 做成定时任务，每晚十点自动推送。
- **结果**：得到一台“每天准时上菜的阿泰选题雷达”，稳定产出候选选题。

### 2. 选题体检器（进一步筛选）

- **流程**：
  1. 将选题拆成 3-5 个核心问题。
  2. 整理数据、案例和观点，标注信息来源与可信度。
  3. 站在反方给逻辑和证据挑漏洞。
- **成果**：生成研究底稿，含思维导图、数据表，指出关键盲区，重新定义选题。
  案例：选题“网吧为什么又活过来了” → 快速生成底稿，判断是否值得做。

### 3. 代码审查 skill

- **问题**：不懂编程，AI 给代码声称算出了结果，但无法判断真伪。
- **解决**：知识库推荐“代码审查 skill”，AI 写出代码后可调用该 skill 审查，找出 bug 和质量问题。

### 4. 华语乐坛巅峰 skill

- **目标**：用 2000-2009 华语乐坛 Top100 制作一个 skill，辅助编曲。
- **原方案**：让模型理解 100 首歌 → 给定主题 → 找曲风 → 给 AI 做歌软件 Suno 写提示词。
- **知识库教程收获**：
  - 最好的操作不是直接告诉 AI 要什么，而是先跟 AI 一起跑通一次任务，把过程做成 skill。
  - 好的 skill 需要持续迭代优化。
- **迭代后**：找出示例歌曲后，再对每首歌进行网络搜索，理解创作理念和背景故事，使提示词更贴合需求。

### 5. 卖了么 App 开发（AI 编程）

- **项目**：炒股自用 App，监测牛市何时结束，防止手欠涨一点就卖。
- **功能**：拦截券商应用、写忏悔语录才能打开的密码本、接入券商 API、牛市逃顶指数监测器。
- **难点**：功能多，写不出条理清晰的需求文档，只能逐步开发 1.0、2.0、3.0，重复造轮子。
- **知识库解决方案**：实战指南《编写产品技术与规范资料》给出四步流程：
  1. 写需求文档（告诉 AI 想要什么，或让 AI 以专家身份生成）。
  2. 根据需求文档生成原型 Demo（功能、界面）。
  3. 根据需求文档和原型图，让 AI 写技术文档（先定技术方案）。
  4. 根据技术文档生成测试文档，开发结束后检查。
- **结果**：按此流程生成原型图，后续开发更游刃有余。

### 6. 工具资源推荐（精华）

- **systematic debugging**：让 debug 从“问 AI 你错哪了”转变为系统性排查，三次修不好自动质疑思路，重新换方案。
- **前端设计 skill**：摆脱 AI 生成界面的千篇一律（大黑底 + 几个颜色模块）。

## 五、总结与展望

- **AI 对自媒体的意义**：不是冲击，而是拥抱。让内容有更多可能性（如华语巅峰歌手写歌、建模预测世界杯），曾经需要大量人力物力的活儿，现在个人也能做。
- **AI 是未来必须拥抱的趋势**：如同当年的互联网浪潮，即使有产业泡沫，也会改变工作方式、生活方式乃至社会运行方式。
- **当下困扰**：不是 AI 离我们太远，而是 AI 变化太快，知识良莠不齐，让人焦虑。
- **吹work AI知识库的价值**：
  - 全网免费公开，持续更新。
  - 一份事无巨细的 AI 说明书。
  - 降低 AI 时代的学习门槛，让普通人理解 AI、使用 AI，并在技术变革中找到自己的位置。

> **核心结论**：好的人机协作，不是把人从创作里删掉，而是把人从杂活里解放出来。最终选什么、相信什么、表达什么，仍由自己负责。







# 健身的“少即是多”：做得少反而更自律

> 核心观点：每周练 6 天、把自己练到力竭，不一定有效；每周练 3 天、只做 5 个动作、留足恢复，反而进步更快。区别在于**懂得忽略什么**。

---

## 一、训练频率：每周 2-3 次，同一肌群 2-3 次

- 每周训练 2-3 次，同一块肌肉每周训练 2-3 次，是增肌的最佳频率。
- 身体既能获得足够刺激，又能充分恢复。
- 研究证实：**肌肉只在乎每周总组数**。12 组就是 12 组，分 3 天还是 6 天做完都一样。
- 每天练的人以为练得越多越好；每周练 3 次的人该练的都练到，恢复到位，从不力竭崩溃。

**关键区别**：
- 每天训练却没有恢复计划 → 没有自律。
- 训练感觉像逃不掉的会议室 → 很容易失去动力。

---

## 二、动作选择：专注复合动作

- 复合动作一次练到多个肌群：
  - 引体向上 → 背阔肌、二头肌、前臂、核心
  - 双杠臂屈伸 → 胸、三头肌、肩膀
  - 深蹲 → 股四头肌、臀大肌、腘绳肌、核心
- 研究显示：只做复合动作的训练计划，增肌效果**不输**加上孤立动作的计划。
- 只需要 4-6 个核心动作：引体向上、俯卧撑、双杠臂屈伸、深蹲、划船。
- 动作变化是为了**进阶**，不是为了花样：
  - 变强了就换更难的版本。
  - 别一次做 15 种变化动作，那不是聪明，只是把瞎练伪装成努力。

---

## 三、组间休息：3-5 分钟

- 休息越久，肌肉和力量增长越多。
- 真正恢复后再做下一组，才能举得更重，进步更快。
- 赶着做下一组的人只是累而已，却把这叫做“强度”。
- 看起来毫不费力，其实是“偷懒式聪明”。

---

## 四、训练量：每块肌肉每周 10-20 组

- 每块肌肉每周 10-20 组是最佳范围，超过收益递减。
- 如果每周练一块肌肉 2-3 次，每次约 **4-8 组高强度训练组**。
- 每组 5-15 次，做到接近力竭。
- 超过这个量，只是更累，不会长得更快。
- 常见错误：背部一周做 30+ 组（五组引体、五组反手引体、三组划船 × 每周 2-3 次），太多了。

---

## 五、有氧：每天走路，别做 HIIT 把自己耗尽

- HIIT 在减脂上并不比中等强度有氧更有效。
- HIIT 会飙升压力荷尔蒙，事后更容易饿，高强度会把人耗尽。
- 走路可以每天走，完全没有心理负担。
- 配速：能说话，但不能完整聊天。
- 每天活动量一周下来能让消耗的热量相差数千大卡。
- 看起来很懒，但确实有效。

---

## 六、睡眠：7-8 小时，没有商量余地

- 肌肉不是在健身房长出来的，是在睡觉时长出来的。
- 睡得很差 → 身体进入损伤控制模式：肌肉更少、压力更大、疼痛更多。
- 每周练 6 天但睡得很差的人：效果减半，力竭风险翻倍。
- 7-8 小时睡眠是最“懒”的增肌方法，效果胜过任何补剂。
- 别只花一小时优化训练计划，却把睡眠搞得一团糟。

---

## 七、哪种方式更需要自律？

| | 方案 A | 方案 B |
|---|---|---|
| 训练频率 | 每周 6 天 | 每周 3 天 |
| 饮食 | 吃到自己都讨厌 | 简单 |
| 有氧 | 把自己搞垮 | 每天走路 |
| 训练量 | 不断加量 | 10-20 组就停 |
| 结果 | 三个月力竭崩溃 | 坚持很多年，持续进步 |
| 当下感觉 | 更辛苦 | 看起来懒 |
| 长期自律 | 低 | 高 |

- 大多数人选 A，因为当下感觉更辛苦。
- 但从长远看，**忍住不加量、不跟风、无视好胜心、在别人眼里显得懒**，才是真正的自律。
- 只做真正有效的事。

---

## 总结

- 少练、练对、恢复好、睡够。
- 肌肉在乎总组数，不在乎你分几天练。
- 复合动作 + 3-5 分钟组间休息 + 每肌群 10-20 组 + 每天走路 + 7-8 小时睡眠。
- 做得少不是懒，是清楚该忽略什么。
- **只做真正有效的事，才是长期自律。**










# 不想玩手机时，可以尝试的 9 件高回报小事

## 核心问题与原理

-   **现象**：放下手机后感到空虚，不自觉地又摸回去。
-   **本质**：不是意志力差，而是大脑被多巴胺劫持。短视频等高频刺激**调高了大脑的“刺激阈值”**，使其对低刺激的普通活动失去兴趣。
-   **解法**：不用意志力硬扛，而是给大脑一个**真实的“平替”**——能带来踏实满足感和长期回报的事。

## 九件高回报小事清单

### 1. 🚶‍♀️ 出门散步
-   **原理**：斯坦福大学研究发现，走路能**提升创造力81%**，激活大脑产生灵感和整合记忆的“默认模式网络”。
-   **做法**：不带目的出门走15-20分钟，手机开勿扰，边走边随便想。

### 2. ✍️ 写三行日记
-   **原理**：积极心理学之父塞利格曼的研究证实，记录正向经历和行动意图能**显著提升幸福感和目标执行力**。
-   **做法**：只需5分钟，写下三行：
    1.  今天最重要的一件事。
    2.  我的感受。
    3.  明天想做什么。

### 3. 🌬️ 做5分钟深慢呼吸
-   **原理**：哈佛医学院研究表明，它能**激活副交感神经系统**，将你从焦虑的应激模式切换至平静清醒模式。
-   **做法**：吸气4秒 → 屏息4秒 → 呼气6秒，重复五组。

### 4. 📖 读十页书
-   **原理**：阅读需要持续注意力，能**重新训练被碎片信息破坏的专注力**。长期坚持阅读的人，在知识积累和思维深度上会与不读书的人产生断层式差距。
-   **做法**：随手放一本感兴趣的书，想刷手机时就拿起来读十页。

### 5. 🗂️ 整理一个小空间
-   **原理**：麻省理工学院研究发现，杂乱环境会**持续消耗大脑的认知资源**，造成莫名的疲惫和焦虑。
-   **做法**：花10分钟，整理一个抽屉或桌面。完成后大脑会获得真实的掌控感和成就感。

### 6. 💡 学一个微技能
-   **原理**：每次学会新东西，大脑都会经历微量的“突触重塑”，这是智识增长的底层机制。
-   **做法**：花5-10分钟，学一个单词、一段历史或一个吉他和弦。

### 7. 💌 发一条真诚的消息
-   **原理**：哈佛大学长达75年的幸福研究核心结论：**良好的人际关系是幸福感最重要的来源**。深度关系靠小温度点滴积累。
-   **做法**：真诚地想到一个人，发一句真心想说的话，而非群发。

### 8. ✅ 做一件拖延很久的小事
-   **原理**：心理学中的“蔡格尼克效应”指出，未完成的事会在潜意识里**持续消耗心理能量**。
-   **做法**：把那件悬而未决的小事（回邮件、预约、还东西）做掉，如释重负。

### 9. 🧘 静坐5分钟
-   **原理**：麻省理工的神经科学研究发现，大脑在安静休息时会进行深度的记忆整合和信息处理，这是手机给不了的真正恢复。
-   **做法**：坐下来，闭上眼，允许思绪自然流动，不需要任何技巧，只是安静地待5分钟。

## 总结

这九件事的共同点是，它们提供的满足感是**真实、累积、内化**的，与手机带来的短暂刺激后的空虚截然不同。下次不想又不知做什么时，从这里挑一件就行。你只需要改变今天一次，这一次就是开始。
`,

    // 【需求 2】在原有提示词之后追加的"时间戳要求"片段。
    // 只在"带时间戳"版本里拼接到 OBSIDIAN_SKILL_PROMPT 之后。
    OBSIDIAN_TIMESTAMP_EXTRA: `

【时间戳要求（本次任务特别重要，请严格遵守）】
本次提供的字幕每一条前面都带有 [MM:SS] 或 [HH:MM:SS] 格式的时间戳，
表示该句字幕在视频中的播放时间。
请在整理笔记时，为每个要点、每个段落或每个小节末尾，用加粗方括号
标注其对应的时间戳，例如：

- 关键结论…… **[00:32]**
- 演示步骤二…… **[03:15]**
- 章节总结…… **[12:08]**

规则：
1. 时间戳必须来自字幕中已给出的内容，不要编造。
2. 若某段内容跨越多个时间点，标注该段起始位置的时间戳。
3. 小于一小时用 [MM:SS]，超过一小时用 [HH:MM:SS]，与字幕格式保持一致。
4. 时间戳用加粗方括号 **[...]** 表示，让它在一大段文字里比较显眼。
5. 用户会依赖这些时间戳直接跳转到视频对应位置来进一步了解，所以
   时间戳的准确性和可读性都很重要。`,

    async sendSubtitleToDeepSeek(btn) {
      if (btn) {
        btn.style.pointerEvents = "none";
        btn.style.opacity = "0.65";
      }
      try {
        encoder.showToast("正在获取字幕…");

        const subtitle = await this.setupData();
        if (!subtitle) throw "当前页面还没有读取到视频信息";

        const languages = (subtitle.subtitles || []).filter(
          (item) => item.lan !== "close" && item.lan !== "local",
        );
        if (!languages.length) throw "当前视频没有可用的在线字幕";

        const lan =
          encoder.currentLan &&
          languages.some((item) => item.lan === encoder.currentLan)
            ? encoder.currentLan
            : languages[0].lan;

        const data = await this.getSubtitle(lan);
        if (!data || !Array.isArray(data.body) || !data.body.length)
          throw "字幕内容为空";

        const srt = encoder.encodeToSRT(data.body);
        const title = this.getCleanTitle();
        const lanDoc = (this.getSubtitleInfo(lan) || {}).lan_doc || lan;

        // ===== 组装发送给 DeepSeek 的完整提示词 =====
        const prompt =
          this.OBSIDIAN_SKILL_PROMPT +
          `\n\n===== 以下是要处理的视频字幕 =====\n` +
          `视频标题：${title}\n` +
          `字幕语言：${lanDoc}\n` +
          `字幕条数：${data.body.length}\n\n` +
          srt;

        // 写入 GM 存储，供 DeepSeek 页面读取
        let stored = false;
        try {
          if (typeof GM_setValue === "function") {
            GM_setValue(DS_STORAGE_KEY, { text: prompt, ts: Date.now() });
            stored = true;
          }
        } catch (e) {
          console.error("[BiliTK→DS] 写入 GM 存储失败", e);
        }

        // 兜底：同时复制一份到剪贴板
        await this.copyTextToClipboard(prompt);

        window.open("https://chat.deepseek.com/", "_blank");

        encoder.showToast(
          stored
            ? "✅ 已打开 DeepSeek，正在自动发送字幕…"
            : "✅ 已复制字幕并打开 DeepSeek，请粘贴发送",
        );
      } catch (e) {
        console.error("发送字幕到 DeepSeek 失败", e);
        encoder.showToast(`❌ 发送失败：${e}`, "error");
      } finally {
        if (btn) {
          btn.style.pointerEvents = "";
          btn.style.opacity = "";
        }
      }
    },

    // 【需求 2】与 sendSubtitleToDeepSeek 相同的流程，但：
    //   ① 字幕转成 "[MM:SS] 内容" 形式，让 DeepSeek 能读到时间信息
    //   ② 在 prompt 里追加 OBSIDIAN_TIMESTAMP_EXTRA，要求笔记里也带时间戳
    async sendSubtitleToDeepSeekWithTimestamps(btn) {
      if (btn) {
        btn.style.pointerEvents = "none";
        btn.style.opacity = "0.65";
      }
      try {
        encoder.showToast("正在获取字幕…");

        const subtitle = await this.setupData();
        if (!subtitle) throw "当前页面还没有读取到视频信息";

        const languages = (subtitle.subtitles || []).filter(
          (item) => item.lan !== "close" && item.lan !== "local",
        );
        if (!languages.length) throw "当前视频没有可用的在线字幕";

        const lan =
          encoder.currentLan &&
          languages.some((item) => item.lan === encoder.currentLan)
            ? encoder.currentLan
            : languages[0].lan;

        const data = await this.getSubtitle(lan);
        if (!data || !Array.isArray(data.body) || !data.body.length)
          throw "字幕内容为空";

        // 用带时间戳的纯文本替代 SRT，更简洁、也更容易被模型利用
        const timestamped = this.formatSubtitleWithTimestamps(data.body);
        const title = this.getCleanTitle();
        const lanDoc = (this.getSubtitleInfo(lan) || {}).lan_doc || lan;

        const prompt =
          this.OBSIDIAN_SKILL_PROMPT +
          this.OBSIDIAN_TIMESTAMP_EXTRA +
          `\n\n===== 以下是要处理的视频字幕（每条均带时间戳）=====\n` +
          `视频标题：${title}\n` +
          `字幕语言：${lanDoc}\n` +
          `字幕条数：${data.body.length}\n\n` +
          timestamped;

        let stored = false;
        try {
          if (typeof GM_setValue === "function") {
            GM_setValue(DS_STORAGE_KEY, { text: prompt, ts: Date.now() });
            stored = true;
          }
        } catch (e) {
          console.error("[BiliTK→DS] 写入 GM 存储失败", e);
        }

        await this.copyTextToClipboard(prompt);
        window.open("https://chat.deepseek.com/", "_blank");

        encoder.showToast(
          stored
            ? "✅ 已打开 DeepSeek，正在自动发送带时间戳的字幕…"
            : "✅ 已复制字幕并打开 DeepSeek，请粘贴发送",
        );
      } catch (e) {
        console.error("发送带时间戳字幕到 DeepSeek 失败", e);
        encoder.showToast(`❌ 发送失败：${e}`, "error");
      } finally {
        if (btn) {
          btn.style.pointerEvents = "";
          btn.style.opacity = "";
        }
      }
    },

    // 【需求 2】把 BCC 字幕的 body 转成 "[MM:SS] 内容" 的逐行纯文本。
    // 超过一小时用 HH:MM:SS，不超过则用 MM:SS，和展示习惯一致。
    formatSubtitleWithTimestamps(body) {
      const pad = (n) => String(n).padStart(2, "0");
      return body
        .map(({ from, content }) => {
          const total = Math.max(0, Math.floor(Number(from) || 0));
          const h = Math.floor(total / 3600);
          const m = Math.floor((total % 3600) / 60);
          const s = total % 60;
          const time =
            h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
          // 换行符替换成空格，保证"一行一条"，模型更容易对齐时间
          return `[${time}] ${String(content || "").replace(/\n/g, " ")}`;
        })
        .join("\n");
    },

    async copyTextToClipboard(text) {
      try {
        // ① 油猴 API（最稳，不受 HTTPS 限制）
        if (typeof GM_setClipboard !== "undefined") {
          GM_setClipboard(text, "text");
          return true;
        }
        // ② 浏览器 Clipboard API（需要 HTTPS + 用户手势）
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
        // ③ 兜底：临时 textarea + execCommand
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        ta.style.top = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch (e) {
        console.error("剪贴板写入失败", e);
        return false;
      }
    },

    // ==================== 悬浮按钮右键菜单 ====================
    // 【改进点 9】统一的菜单关闭入口：
    //   原实现只在"点击菜单外部"时移除监听，点菜单项时残留，
    //   这里确保任何路径关闭菜单都清理掉 document 上的关闭监听。
    showFloatingButtonMenu(x, y) {
      const oldMenu = document.getElementById("cc-subtitle-button-menu");
      oldMenu && oldMenu.remove();
      const menu = elements.createAs(
        "div",
        {
          id: "cc-subtitle-button-menu",
          style:
            "position:fixed;z-index:1048578;min-width:190px;padding:6px 0;background:#fff;border:1px solid #e5e9ef;border-radius:4px;box-shadow:0 4px 16px rgba(0,0,0,.18);font-size:14px;color:#18191c;",
        },
        document.body,
      );

      let closeHandler = null;
      const closeMenu = () => {
        if (closeHandler) {
          document.removeEventListener("mousedown", closeHandler, true);
          closeHandler = null;
        }
        menu.remove();
      };

      const addItem = (label, handler) =>
        elements.createAs(
          "div",
          {
            innerText: label,
            style: "padding:9px 14px;cursor:pointer;white-space:nowrap;",
            onmouseenter: function () {
              this.style.background = "#f1f2f3";
            },
            onmouseleave: function () {
              this.style.background = "#fff";
            },
            onclick: function (e) {
              e.stopPropagation();
              closeMenu();
              handler();
            },
          },
          menu,
        );

      addItem("打开字幕下载窗口", () => this.openDownloadDialog());
      addItem("批量下载字幕", () => this.openBatchDialog());
      addItem("复制当前 SRT 字幕", () => this.copyCurrentSubtitleSRT());
      addItem("复制视频链接", () => this.copyVideoLink());
      addItem("复制 Markdown 链接", () => this.copyVideoLinkMarkdown());
      addItem("发送字幕到 DeepSeek", () => this.sendSubtitleToDeepSeek());
      addItem("发送字幕到 DeepSeek（带时间戳）", () =>
        this.sendSubtitleToDeepSeekWithTimestamps(),
      );
      addItem("临时关闭悬浮按钮（本页）", () =>
        this.hideFloatingButtonTemporarily(),
      );
      addItem("永久关闭悬浮按钮", () => this.hideFloatingButtonPermanently());

      const width = 210;
      // 菜单项增加到 9 个，高度同步调整
      const height = 122 + 36 * 3;
      menu.style.left =
        Math.max(8, Math.min(x, window.innerWidth - width - 8)) + "px";
      menu.style.top =
        Math.max(8, Math.min(y, window.innerHeight - height - 8)) + "px";

      closeHandler = (e) => {
        if (!menu.contains(e.target)) closeMenu();
      };
      setTimeout(
        () => document.addEventListener("mousedown", closeHandler, true),
        0,
      );
    },

    getBatchItems() {
      const state = this.window.__INITIAL_STATE__ || {};
      const videoData = state.videoData || this.getInfo("videoData") || {};
      const current = {
        bvid: this.getInfo("bvid") || this.bvid,
        aid: this.getInfo("aid") || this.aid,
        cid: this.cid,
        ep_id: this.epid,
        title: this.getInfo("h1Title") || document.title,
      };
      const normalize = (raw, index, defaults = {}) => {
        if (!raw) return null;
        const source = raw.episode || raw.video || raw;
        const bvid = source.bvid || source.bv_id || raw.bvid || defaults.bvid;
        const aid = source.aid || raw.aid || defaults.aid;
        const cid =
          source.cid || raw.cid || defaults.cid || source.pages?.[0]?.cid;
        const ep_id =
          source.ep_id ||
          source.epid ||
          raw.ep_id ||
          raw.epid ||
          defaults.ep_id;
        if (!cid && !ep_id && !bvid && !aid) return null;
        const title =
          source.part ||
          source.title ||
          source.show_title ||
          source.arc?.title ||
          raw.part ||
          raw.title ||
          defaults.title ||
          `选集 ${index + 1}`;
        return {
          bvid,
          aid,
          cid,
          ep_id,
          title: String(title).trim() || `选集 ${index + 1}`,
        };
      };
      const unique = (items) => {
        const seen = new Set();
        return items.filter((item) => {
          const key = item.cid
            ? `cid:${item.cid}`
            : item.ep_id
              ? `ep:${item.ep_id}`
              : `${item.bvid || ""}:${item.aid || ""}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      };
      const domEpisodes = Array.from(
        document.querySelectorAll(
          ".bpx-player-ctrl-eplist-multi-menu-item[data-cid], .bilibili-player-video-sections-item[data-cid], .bilibili-player-video-section-list-item[data-cid]",
        ),
      )
        .map((node, index) =>
          normalize(
            {
              cid: node.dataset.cid,
              title:
                node
                  .querySelector(".bpx-player-ctrl-eplist-multi-menu-item-text")
                  ?.textContent?.trim() || node.textContent?.trim(),
            },
            index,
            current,
          ),
        )
        .filter(Boolean);
      const domItems = unique(domEpisodes);
      if (domItems.length) {
        return { label: `播放器选集（${domItems.length}集）`, items: domItems };
      }
      const collection =
        state.ugc_season ||
        state.ugcSeason ||
        videoData.ugc_season ||
        videoData.ugcSeason ||
        this.getInfo("ugc_season") ||
        this.window.ugc_season;
      const collectionRaw = [];
      if (Array.isArray(collection?.sections)) {
        collection.sections.forEach((section) => {
          if (Array.isArray(section?.episodes))
            collectionRaw.push(...section.episodes);
        });
      }
      if (Array.isArray(collection?.episodes))
        collectionRaw.push(...collection.episodes);
      const collectionItems = unique(
        collectionRaw
          .map((item, index) => normalize(item, index, current))
          .filter(Boolean),
      );
      if (collectionItems.length) {
        return {
          label: `合集（${collectionItems.length}集）`,
          items: collectionItems,
        };
      }

      const pages = videoData.pages || state.pages || [];
      const pageItems = Array.isArray(pages)
        ? unique(
            pages
              .map((item, index) => normalize(item, index, current))
              .filter(Boolean),
          )
        : [];
      if (pageItems.length) {
        return {
          label: `当前视频选集（${pageItems.length}集）`,
          items: pageItems,
        };
      }

      const seasonData =
        this.window.__NEXT_DATA__?.props?.pageProps?.dehydratedState?.queries?.find(
          (query) => query?.queryKey?.[0] == "pgc/view/web/season",
        )?.state?.data;
      const seasonEpisodes =
        (seasonData?.seasonInfo ?? seasonData)?.mediaInfo?.episodes ||
        seasonData?.episodes ||
        state.epList ||
        [];
      const seasonItems = Array.isArray(seasonEpisodes)
        ? unique(
            seasonEpisodes
              .map((item, index) => normalize(item, index, current))
              .filter(Boolean),
          )
        : [];
      if (seasonItems.length) {
        return {
          label: `合集/选集（${seasonItems.length}集）`,
          items: seasonItems,
        };
      }

      const currentItem = normalize(current, 0, current);
      return { label: "当前视频", items: currentItem ? [currentItem] : [] };
    },
    getBatchLanguageOptions() {
      const result = [{ value: "__auto__", label: "自动选择可用语言" }];
      const seen = new Set();
      (this.subtitle?.subtitles || []).forEach((item) => {
        if (
          item.lan === "close" ||
          item.lan === "local" ||
          !item.lan ||
          seen.has(item.lan)
        )
          return;
        seen.add(item.lan);
        result.push({ value: item.lan, label: item.lan_doc || item.lan });
      });
      return result;
    },
    async fetchBatchSubtitleConfig(item) {
      const params = [];
      if (item.cid) params.push(`cid=${encodeURIComponent(item.cid)}`);
      else if (item.ep_id)
        params.push(`ep_id=${encodeURIComponent(item.ep_id)}`);
      if (item.aid) params.push(`aid=${encodeURIComponent(item.aid)}`);
      else if (item.bvid) params.push(`bvid=${encodeURIComponent(item.bvid)}`);
      if (!params.length) throw "缺少视频参数";
      const url = `https://api.bilibili.com/x/player${item.cid ? "/wbi" : ""}/v2?${params.join("&")}`;
      let ret = await fetch(url, { credentials: "include" }).then((res) =>
        res.json(),
      );
      let subtitle;
      if (ret.code === -404 && item.cid) {
        const dmParams = item.aid
          ? `aid=${encodeURIComponent(item.aid)}`
          : `bvid=${encodeURIComponent(item.bvid || "")}`;
        ret = await fetch(
          `https://api.bilibili.com/x/v2/dm/view?${dmParams}&oid=${encodeURIComponent(item.cid)}&type=1`,
          { credentials: "include" },
        ).then((res) => res.json());
        if (ret.code !== 0) throw ret.message || "无法读取字幕配置";
        subtitle = ret.data?.subtitle;
      } else {
        if (ret.code !== 0 || !ret.data?.subtitle)
          throw ret.message || `读取字幕配置失败（${ret.code}）`;
        subtitle = ret.data.subtitle;
      }
      const subtitles = (subtitle?.subtitles || []).filter(
        (info) =>
          info.lan !== "close" && info.lan !== "local" && info.subtitle_url,
      );
      if (!subtitles.length) throw "该集没有可下载字幕";
      return { subtitles };
    },
    async fetchBatchSubtitle(item, language) {
      const config = await this.fetchBatchSubtitleConfig(item);
      const info =
        language === "__auto__"
          ? config.subtitles[0]
          : config.subtitles.find((subtitle) => subtitle.lan === language);
      if (!info) throw `没有语言为“${language}”的字幕`;
      const subtitleUrl = new URL(
        String(info.subtitle_url).replace(/^https?:\/\//, "//"),
        location.href,
      ).href;
      // 字幕 CDN 通常不允许跨域携带凭据；这里保持和原单集下载一样使用默认凭据策略。
      const response = await fetch(subtitleUrl);
      if (!response.ok && response.status !== 0)
        throw `字幕请求失败（${response.status}）`;
      const data = await response.json();
      if (!data || !Array.isArray(data.body)) throw "字幕数据格式错误";
      return { data, language: info.lan_doc || info.lan };
    },
    encodeBatchSubtitle(data, type) {
      switch (String(type).toUpperCase()) {
        case "ASS":
          return encoder.encodeToASS(data.body);
        case "SRT":
          return encoder.encodeToSRT(data.body);
        case "LRC":
          return encoder.encodeToLRC(data.body);
        case "VTT":
          return encoder.encodeToVTT(data.body);
        case "TXT":
          return data.body.map((item) => item.content).join("\r\n");
        case "BCC":
          return JSON.stringify(data, undefined, 2);
        default:
          throw `不支持的格式：${type}`;
      }
    },
    safeBatchName(name) {
      return (
        String(name || "字幕")
          .replace(/[\\/:*?"<>|]/g, "_")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 100) || "字幕"
      );
    },
    crc32(bytes) {
      let crc = 0xffffffff;
      for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
          crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      return (crc ^ 0xffffffff) >>> 0;
    },
    createSubtitleZip(entries) {
      const textEncoder = new TextEncoder();
      const localParts = [];
      const centralParts = [];
      let offset = 0;
      const set16 = (view, position, value) =>
        view.setUint16(position, value, true);
      const set32 = (view, position, value) =>
        view.setUint32(position, value, true);
      entries.forEach((entry) => {
        const nameBytes = textEncoder.encode(entry.name);
        const dataBytes = textEncoder.encode(entry.content);
        const crc = this.crc32(dataBytes);
        const local = new Uint8Array(30);
        const localView = new DataView(local.buffer);
        set32(localView, 0, 0x04034b50);
        set16(localView, 4, 20);
        set16(localView, 6, 0x800);
        set16(localView, 8, 0);
        set16(localView, 10, 0);
        set16(localView, 12, 0);
        set32(localView, 14, crc);
        set32(localView, 18, dataBytes.length);
        set32(localView, 22, dataBytes.length);
        set16(localView, 26, nameBytes.length);
        set16(localView, 28, 0);
        localParts.push(local, nameBytes, dataBytes);

        const central = new Uint8Array(46);
        const centralView = new DataView(central.buffer);
        set32(centralView, 0, 0x02014b50);
        set16(centralView, 4, 20);
        set16(centralView, 6, 20);
        set16(centralView, 8, 0x800);
        set16(centralView, 10, 0);
        set16(centralView, 12, 0);
        set16(centralView, 14, 0);
        set32(centralView, 16, crc);
        set32(centralView, 20, dataBytes.length);
        set32(centralView, 24, dataBytes.length);
        set16(centralView, 28, nameBytes.length);
        set16(centralView, 30, 0);
        set16(centralView, 32, 0);
        set16(centralView, 34, 0);
        set16(centralView, 36, 0);
        set32(centralView, 38, 0);
        set32(centralView, 42, offset);
        centralParts.push(central, nameBytes);
        offset += local.length + nameBytes.length + dataBytes.length;
      });
      const centralOffset = offset;
      const centralSize = centralParts.reduce(
        (total, part) => total + part.length,
        0,
      );
      const end = new Uint8Array(22);
      const endView = new DataView(end.buffer);
      set32(endView, 0, 0x06054b50);
      set16(endView, 4, 0);
      set16(endView, 6, 0);
      set16(endView, 8, entries.length);
      set16(endView, 10, entries.length);
      set32(endView, 12, centralSize);
      set32(endView, 16, centralOffset);
      set16(endView, 20, 0);
      return new Blob([...localParts, ...centralParts, end], {
        type: "application/zip",
      });
    },
    downloadBatchBlob(blob, name) {
      const url = URL.createObjectURL(blob);
      const link = elements.createAs(
        "a",
        { href: url, download: name, style: "display:none;" },
        document.body,
      );
      link.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        link.remove();
      }, 15000);
    },

    // ==================== 批量下载 ====================
    // 【改进点 8】并发 + 重试：
    //   - 并发：一次性最多拉取 CONCURRENCY 集，比串行快好几倍；
    //   - 重试：单集失败自动重试 MAX_RETRY 次，防网络抖动导致整集失败。
    async startBatchDownload(items, language, type, status, startButton) {
      if (startButton.dataset.busy === "1") return;
      startButton.dataset.busy = "1";
      startButton.style.opacity = "0.65";
      startButton.style.pointerEvents = "none";

      const CONCURRENCY = 4;
      const MAX_RETRY = 2;
      const RETRY_DELAY = 500;

      const entries = []; // 结果数组（含 index 便于排序还原顺序）
      const failed = [];
      let completedCount = 0;

      // 带重试的单集获取
      const fetchWithRetry = async (item) => {
        let lastErr;
        for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
          try {
            return await this.fetchBatchSubtitle(item, language);
          } catch (e) {
            lastErr = e;
            if (attempt < MAX_RETRY) {
              // 重试前稍等，给网络一点恢复时间
              await new Promise((r) => setTimeout(r, RETRY_DELAY));
            }
          }
        }
        throw lastErr;
      };

      // 工作池：cursor 共享递增，天然完成并发调度
      let cursor = 0;
      const worker = async () => {
        while (true) {
          const index = cursor++;
          if (index >= items.length) return;
          const item = items[index];
          try {
            const result = await fetchWithRetry(item);
            const extension = String(type).toLowerCase();
            entries.push({
              index,
              name: `${String(index + 1).padStart(2, "0")}_${this.safeBatchName(item.title)}.${extension}`,
              content: this.encodeBatchSubtitle(result.data, type),
            });
          } catch (error) {
            failed.push({ index, message: `${item.title}：${error}` });
          } finally {
            completedCount++;
            status.innerText = `已完成 ${completedCount}/${items.length}（成功 ${entries.length}，失败 ${failed.length}）`;
          }
        }
      };

      const workerCount = Math.min(CONCURRENCY, items.length);
      const workers = [];
      for (let i = 0; i < workerCount; i++) workers.push(worker());
      await Promise.all(workers);

      // 按原始顺序排序，保证 ZIP 内顺序和列表一致
      entries.sort((a, b) => a.index - b.index);
      failed.sort((a, b) => a.index - b.index);

      if (entries.length) {
        const zipName = `Bilibili字幕批量下载_${new Date().toISOString().slice(0, 10)}.zip`;
        this.downloadBatchBlob(
          this.createSubtitleZip(
            entries.map(({ name, content }) => ({ name, content })),
          ),
          zipName,
        );
      }

      startButton.dataset.busy = "0";
      startButton.style.opacity = "1";
      startButton.style.pointerEvents = "auto";

      const failedMessages = failed.map((f) => f.message);
      status.innerText = failed.length
        ? `完成：${entries.length} 集，失败：${failed.length} 集（${failedMessages.slice(0, 2).join("；")}${failed.length > 2 ? "；…" : ""}）`
        : `完成：${entries.length} 集，已下载 ZIP 文件`;

      if (entries.length)
        encoder.showToast(`✅ 批量字幕已打包：${entries.length} 集`);
      else encoder.showToast("❌ 没有成功获取字幕", "error");
    },
    createBatchDialog(items, sourceLabel) {
      const oldDialog = document.getElementById("cc-batch-dialog");
      oldDialog && oldDialog.remove();
      const overlay = elements.createAs(
        "div",
        {
          id: "cc-batch-dialog",
          style:
            "position:fixed;inset:0;background:transparent;pointer-events:none;z-index:1048576;",
        },
        document.body,
      );
      const panel = elements.createAs(
        "div",
        {
          style:
            "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:680px;max-width:calc(100vw - 30px);box-sizing:border-box;padding:18px;background:#fff;border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.2);pointer-events:auto;color:#18191c;font-size:14px;",
        },
        overlay,
      );
      if (!document.getElementById("cc-batch-dialog-style")) {
        elements.createAs(
          "style",
          {
            id: "cc-batch-dialog-style",
            innerHTML:
              "@media (max-width:720px){.cc-batch-control-panel{grid-template-columns:auto minmax(0,1fr) auto minmax(0,1fr)!important}.cc-batch-control-panel>:nth-child(5){grid-column:1}.cc-batch-control-panel>:nth-child(6){grid-column:2}}",
          },
          document.head,
        );
      }
      const header = elements.createAs(
        "div",
        {
          innerText: "批量下载字幕",
          style:
            "font-size:20px;line-height:26px;color:#00a1d6;font-weight:500;margin-bottom:12px;",
        },
        panel,
      );
      elements.createAs(
        "span",
        {
          innerText: sourceLabel,
          style:
            "display:block;color:#99a2aa;font-size:12px;margin-bottom:10px;",
        },
        panel,
      );
      const controlPanel = elements.createAs(
        "div",
        {
          className: "cc-batch-control-panel",
          style:
            "display:grid;grid-template-columns:auto minmax(150px,1fr) auto minmax(180px,1.2fr) auto 90px;column-gap:10px;row-gap:8px;align-items:center;margin-bottom:10px;",
        },
        panel,
      );
      elements.createAs("span", { innerText: "范围：" }, controlPanel);
      const scopeSelect = elements.createAs(
        "select",
        {
          style: "height:30px;width:100%;min-width:0;box-sizing:border-box;",
          innerHTML: `<option value="all">合集（全部 ${items.length} 集）</option><option value="selected">选集（勾选项目）</option>`,
        },
        controlPanel,
      );
      elements.createAs("span", { innerText: "语言：" }, controlPanel);
      const languageSelect = elements.createAs(
        "select",
        { style: "height:30px;width:100%;min-width:0;box-sizing:border-box;" },
        controlPanel,
      );
      this.getBatchLanguageOptions().forEach((option) =>
        elements.createAs(
          "option",
          { value: option.value, innerText: option.label },
          languageSelect,
        ),
      );
      elements.createAs("span", { innerText: "格式：" }, controlPanel);
      const formatSelect = elements.createAs(
        "select",
        {
          style: "height:30px;width:90px;min-width:90px;box-sizing:border-box;",
          innerHTML: ["ASS", "SRT", "LRC", "VTT", "TXT", "BCC"]
            .map((type) => `<option value="${type}">${type}</option>`)
            .join(""),
          value: localStorage.defaultSubtitleType || "SRT",
        },
        controlPanel,
      );
      const selectionHeader = elements.createAs(
        "div",
        {
          style:
            "display:flex;align-items:center;border-bottom:1px solid #e5e9ef;padding:6px 4px;",
        },
        panel,
      );
      const allToggle = elements.createAs(
        "input",
        { type: "checkbox", checked: true },
        selectionHeader,
      );
      elements.createAs(
        "span",
        { innerText: "全选 / 取消全选", style: "margin-left:6px;" },
        selectionHeader,
      );
      const list = elements.createAs(
        "div",
        {
          style:
            "max-height:280px;overflow:auto;border:1px solid #e5e9ef;border-top:0;padding:4px 8px;",
        },
        panel,
      );
      const checks = [];
      items.forEach((item, index) => {
        const row = elements.createAs(
          "label",
          {
            style:
              "display:flex;align-items:center;gap:7px;min-height:30px;border-bottom:1px solid #f1f2f3;cursor:pointer;",
          },
          list,
        );
        const checkbox = elements.createAs(
          "input",
          { type: "checkbox", checked: true },
          row,
        );
        checks.push(checkbox);
        checkbox.onchange = () => {
          allToggle.checked = checks.every((check) => check.checked);
        };
        elements.createAs(
          "span",
          {
            innerText: `${index + 1}. ${item.title}`,
            style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
          },
          row,
        );
      });
      allToggle.onchange = () =>
        checks.forEach((check) => (check.checked = allToggle.checked));
      const status = elements.createAs(
        "div",
        {
          innerText:
            "选择范围、语言和格式后，点击开始批量下载。文件会打包为 ZIP。",
          style:
            "color:#99a2aa;font-size:12px;line-height:20px;min-height:20px;margin-top:10px;",
        },
        panel,
      );
      const actions = elements.createAs(
        "div",
        {
          style:
            "display:flex;justify-content:flex-end;gap:8px;margin-top:10px;",
        },
        panel,
      );
      const closeButton = elements.createAs(
        "a",
        {
          innerText: "关闭",
          style:
            "height:24px;background:#99a2aa;color:#fff;padding:7px 14px;cursor:pointer;border-radius:2px;",
          onclick: () => overlay.remove(),
        },
        actions,
      );
      const startButton = elements.createAs(
        "a",
        {
          innerText: "开始批量下载",
          style:
            "height:24px;background:#00a1d6;color:#fff;padding:7px 14px;cursor:pointer;border-radius:2px;",
        },
        actions,
      );
      startButton.onclick = () => {
        const selected =
          scopeSelect.value === "all"
            ? items
            : items.filter((item, index) => checks[index].checked);
        if (!selected.length) {
          status.innerText = "请至少勾选一集。";
          return;
        }
        this.startBatchDownload(
          selected,
          languageSelect.value,
          formatSelect.value,
          status,
          startButton,
        );
      };
    },
    openBatchDialog() {
      this.setupData()
        .then((subtitle) => {
          if (!subtitle) throw "当前页面还没有读取到视频信息";
          const batch = this.getBatchItems();
          if (!batch.items.length) throw "没有找到可批量处理的合集或选集";
          this.createBatchDialog(batch.items, batch.label);
        })
        .catch((error) => {
          console.error("打开批量下载窗口失败", error);
          if (typeof encoder !== "undefined" && encoder.showToast) {
            encoder.showToast(`❌ 打开批量下载失败：${error}`, "error");
          } else {
            this.toast("打开批量下载窗口失败", error);
          }
        });
    },
    openDownloadDialog() {
      this.setupData()
        .then((subtitle) => {
          const languages = (subtitle?.subtitles || []).filter(
            (item) => item.lan !== "close" && item.lan !== "local",
          );
          if (!languages.length) throw "当前视频没有可用的在线字幕";
          const lan =
            encoder.currentLan &&
            languages.some((item) => item.lan === encoder.currentLan)
              ? encoder.currentLan
              : languages[0].lan;
          return this.getSubtitle(lan).then((data) =>
            encoder.showDialog(data, false, lan),
          );
        })
        .catch((e) => this.toast("打开字幕窗口失败", e));
    },

    // ==================== toast ====================
    // 【改进点 7】没有播放器 toast 容器时回退到 encoder.showToast：
    //   新版 B 站部分场景没有 .bilibili-player-video-toast-top，
    //   原实现直接 return，用户就看不到任何反馈。
    toast(msg, error) {
      if (error) console.error(msg, error);
      if (!this.toastDiv) {
        this.toastDiv = document.createElement("div");
        this.toastDiv.className = "bilibili-player-video-toast-item";
      }
      const panel = elements.getAs(".bilibili-player-video-toast-top");
      if (!panel) {
        if (typeof encoder !== "undefined" && encoder.showToast) {
          encoder.showToast(
            msg + (error ? `：${error}` : ""),
            error ? "error" : "success",
          );
        } else {
          console.warn("[BiliTK]", msg, error);
        }
        return;
      }
      clearTimeout(this.removeTimmer);
      this.toastDiv.innerText = msg + (error ? `:${error}` : "");
      panel.appendChild(this.toastDiv);
      this.removeTimmer = setTimeout(() => {
        panel.contains(this.toastDiv) && panel.removeChild(this.toastDiv);
      }, 3000);
    },

    async updateLocal(data) {
      this.datas.local = data;
      return this.updateSubtitle(data);
    },
    async updateSubtitle(data) {
      this.window.player.updateSubtitle(data);
    },
    loadSubtitle(lan) {
      this.getSubtitle(lan)
        .catch(() => this.setupData(true))
        .then(() => this.getSubtitle(lan))
        .then((data) => this.updateSubtitle(data))
        .then(() =>
          this.toast(
            lan == "close"
              ? "字幕已关闭"
              : `载入字幕:${this.getSubtitleInfo(lan).lan_doc}`,
          ),
        )
        .catch((e) => this.toast("载入字幕失败", e));
    },
    downloadSubtitle(lan, name, direct) {
      this.getSubtitle(lan, name)
        .catch(() => this.setupData(true))
        .then(() => this.getSubtitle(lan, name))
        .then((data) => {
          const item = this.getSubtitleInfo(lan, name);
          return encoder.showDialog(data, direct, item && item.lan);
        })
        .catch((e) => bilibiliCCHelper.toast("获取字幕失败", e));
    },
    async getSubtitle(lan, name) {
      if (this.datas[lan]) return this.datas[lan];
      const item = this.getSubtitleInfo(lan, name);
      if (!item) throw "找不到所选语言字幕" + lan;
      if (this.datas[item.lan]) return this.datas[item.lan];
      return fetch(item.subtitle_url)
        .then((res) => res.json())
        .then((data) => (this.datas[item.lan] = data));
    },
    getSubtitleInfo(lan, name) {
      return this.subtitle.subtitles.find(
        (item) => item.lan == lan || item.lan_doc == name,
      );
    },
    getInfo(name) {
      return (
        this.window[name] ||
        (this.window.__INITIAL_STATE__ &&
          this.window.__INITIAL_STATE__[name]) ||
        (this.window.__INITIAL_STATE__ &&
          this.window.__INITIAL_STATE__.epInfo &&
          this.window.__INITIAL_STATE__.epInfo[name]) ||
        (this.window.__INITIAL_STATE__ &&
          this.window.__INITIAL_STATE__.videoData &&
          this.window.__INITIAL_STATE__.videoData[name])
      );
    },
    getEpid() {
      return (
        this.getInfo("id") ||
        (/ep(\d+)/.test(location.pathname) && +RegExp.$1) ||
        /ss\d+/.test(location.pathname)
      );
    },
    getEpInfo() {
      const bvid = this.getInfo("bvid"),
        epid = this.getEpid(),
        cidMap = this.getInfo("cidMap"),
        page = this?.window?.__INITIAL_STATE__?.p;
      let ep = cidMap?.[bvid];
      if (ep) {
        this.aid = ep.aid;
        this.bvid = ep.bvid;
        this.cid = ep.cids[page];
        return this.cid;
      }
      ep =
        this.window.__NEXT_DATA__?.props?.pageProps?.dehydratedState?.queries?.find(
          (query) => query?.queryKey?.[0] == "pgc/view/web/season",
        )?.state?.data;
      ep = (ep?.seasonInfo ?? ep)?.mediaInfo?.episodes?.find(
        (ep) => epid == true || ep.ep_id == epid,
      );
      if (ep) {
        this.epid = ep.ep_id;
        this.cid = ep.cid;
        this.aid = ep.aid;
        this.bvid = ep.bvid;
        return this.cid;
      }
      ep = this.window.__INITIAL_STATE__?.epInfo;
      if (ep) {
        this.epid = ep.id;
        this.cid = ep.cid;
        this.aid = ep.aid;
        this.bvid = ep.bvid;
        return this.cid;
      }
      ep = this.window.playerRaw?.getManifest();
      if (ep) {
        this.epid = ep.episodeId;
        this.cid = ep.cid;
        this.aid = ep.aid;
        this.bvid = ep.bvid;
        return this.cid;
      }
    },

    // ==================== setupData ====================
    // 【改进点 10】Promise 级缓存：
    //   连点按钮 / 弹窗和批量同时打开时，原实现会各自发起一次完整请求；
    //   现在若同一集的请求仍在飞，后续调用直接复用该 Promise。
    setupData(force) {
      const currentPcid = this.getEpInfo();
      // 已有结果，直接返回（等价于原缓存判断）
      if (this.subtitle && this.pcid == currentPcid && !force) {
        return Promise.resolve(this.subtitle);
      }
      if (
        !force &&
        this._setupPromise &&
        this._setupPromisePcid === currentPcid
      ) {
        return this._setupPromise;
      }
      const p = this._setupDataImpl(force);
      this._setupPromise = p;
      this._setupPromisePcid = currentPcid;
      p.finally(() => {
        // 请求结束后清空缓存，下次 force 刷新或换集时能重新拉
        if (this._setupPromise === p) {
          this._setupPromise = null;
          this._setupPromisePcid = null;
        }
      });
      return p;
    },

    // 【改进点 10】原 setupData 主体，把链式 then 改成 async/await，逻辑等价
    async _setupDataImpl(force) {
      if (location.pathname == "/blackboard/html5player.html") {
        let match = location.search.match(/cid=(\d+)/i);
        if (!match) return;
        this.window.cid = match[1];
        match = location.search.match(/aid=(\d+)/i);
        if (match) this.window.aid = match[1];
        match = location.search.match(/bvid=(\d+)/i);
        if (match) this.window.bvid = match[1];
      }
      this.pcid = this.getEpInfo();
      if ((!this.cid && !this.epid) || (!this.aid && !this.bvid)) return;
      this.player = this.window.player;
      this.subtitle = {
        count: 0,
        subtitles: [
          { lan: "close", lan_doc: "关闭" },
          { lan: "local", lan_doc: "本地字幕" },
        ],
      };
      if (!force) this.datas = { close: { body: [] }, local: { body: [] } };
      decoder.data = undefined;

      const res = await fetch(
        `https://api.bilibili.com/x/player${this.cid ? "/wbi" : ""}/v2?${
          this.cid ? `cid=${this.cid}` : `&ep_id=${this.epid}`
        }${this.aid ? `&aid=${this.aid}` : `&bvid=${this.bvid}`}`,
        { credentials: "include" },
      );
      if (res.status != 200) throw "请求字幕配置失败:" + res.statusText;
      const ret = await res.json();

      // 部分 APP 端字幕需要走 dm/view 接口
      if (ret.code == -404) {
        const res2 = await fetch(
          `//api.bilibili.com/x/v2/dm/view?${
            this.aid ? `aid=${this.aid}` : `bvid=${this.bvid}`
          }&oid=${this.cid}&type=1`,
          { credentials: "include" },
        );
        const ret2 = await res2.json();
        if (ret2.code != 0) throw "无法读取本视频APP字幕配置" + ret2.message;
        this.subtitle = (ret2.data && ret2.data.subtitle) || {
          subtitles: [],
        };
        this.subtitle.count = this.subtitle.subtitles.length;
        this.subtitle.subtitles.forEach(
          (item) =>
            (item.subtitle_url = item.subtitle_url.replace(
              /https?:\/\//,
              "//",
            )),
        );
        this.subtitle.subtitles.push(
          { lan: "close", lan_doc: "关闭" },
          { lan: "local", lan_doc: "本地字幕" },
        );
        this.subtitle.allow_submit = false;
        return this.subtitle;
      }

      if (ret.code != 0 || !ret.data || !ret.data.subtitle)
        throw "读取视频字幕配置错误:" + ret.code + ret.message;
      this.subtitle = ret.data.subtitle;
      this.subtitle.count = this.subtitle.subtitles.length;
      this.subtitle.subtitles.push(
        { lan: "close", lan_doc: "关闭" },
        { lan: "local", lan_doc: "本地字幕" },
      );
      return this.subtitle;
    },

    // ==================== tryInit ====================
    // 【改进点 5】防抖：
    //   MutationObserver 会因 B 站页面 DOM 频繁变动而疯狂调用 tryInit，
    //   每次都触发一次 setupData → 一次 XHR，很容易被风控或造成浪费。
    //   这里统一延迟 300ms 触发，短时间内多次调用只跑最后一次。
    tryInit() {
      clearTimeout(this._initDebounce);
      this._initDebounce = setTimeout(() => {
        this.setupData()
          .then((subtitle) => {
            if (!subtitle) return;
            if (elements.getAs("#bilibili-player-subtitle-btn")) {
              console.log("CC助手已初始化");
            } else if (elements.getAs(".bilibili-player-video-btn-color")) {
              oldPlayerHelper.init(subtitle);
            } else if (
              elements.getAs(".bilibili-player-video-danmaku-setting")
            ) {
              player2x.init(subtitle);
            } else if (
              elements.getAs(".bpx-player-ctrl-subtitle-major-content")
            ) {
              player315.init(subtitle);
            } else if (elements.getAs(".squirtle-subtitle-wrap")) {
              player314.init(subtitle);
            } else {
              console.log("bilibili cc未发现可识别版本播放器");
            }
          })
          .catch((e) => {
            this.toast("CC字幕助手配置失败", e);
          });
      }, 300);
    },

    init() {
      this.registerMenuCommands();
      this.createFloatingButton();
      this.tryInit();
      new MutationObserver((mutations, observer) => {
        for (const mutation of mutations) {
          if (!mutation.target) return;
          if (
            mutation.target.getAttribute("stage") == 1 ||
            mutation.target.classList.contains("bpx-player-subtitle-wrap") ||
            mutation.target.classList.contains("tit") ||
            mutation.target.classList.contains(
              "bpx-player-ctrl-subtitle-bilingual",
            ) ||
            mutation.target.classList.contains("squirtle-quality-wrap")
          ) {
            this.tryInit();
            break;
          }
        }
      }).observe(document.body, {
        childList: true,
        subtree: true,
      });
    },
  };
  bilibiliCCHelper.init();
})();
