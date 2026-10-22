// ==UserScript==
// @name         BiliTK B站工具
// @namespace    https://github.com/SavingPot/BiliTk
// @updateURL    https://raw.githubusercontent.com/SavingPot/BiliTk/main/BiliTk.user.js
// @downloadURL  https://raw.githubusercontent.com/SavingPot/BiliTk/main/BiliTk.user.js
// @version      1.5.4
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
// @grant        GM_openInTab
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
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

    if (pending.ts && Date.now() - pending.ts > 50 * 60 * 1000) {
      try {
        GM_deleteValue(DS_STORAGE_KEY);
      } catch (e) {}
      return;
    }

    let done = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 60;
    let timer = null;
    let tryTimer = null;

    const cleanup = () => {
      done = true;
      if (timer) clearInterval(timer);
      if (tryTimer) clearTimeout(tryTimer);
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

    const simulateTyping = (input, text) => {
      try {
        if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
          const proto =
            input.tagName === "TEXTAREA"
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          input.focus();
          setter.call(input, text);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        input.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(input);
        sel.removeAllRanges();
        sel.addRange(range);
        return document.execCommand("insertText", false, text);
      } catch (e) {
        console.warn("[BiliTK→DS] value setter 注入失败，尝试 execCommand", e);
      }
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
      } catch (e) {}
      return ev;
    };

    const simulateSend = (input) => {
      try {
        input.focus();
        input.dispatchEvent(buildEnterEvent("keydown"));
        input.dispatchEvent(buildEnterEvent("keypress"));
        input.dispatchEvent(buildEnterEvent("keyup"));
      } catch (e) {
        console.warn("[BiliTK→DS] 模拟 Enter 失败", e);
      }
      setTimeout(() => {
        const stillHasText =
          input.tagName === "TEXTAREA" || input.tagName === "INPUT"
            ? input.value.trim().length > 0
            : (input.innerText || "").trim().length > 0;
        if (!stillHasText) return;
        const sendBtn = findSendButton(input);
        if (sendBtn) {
          sendBtn.click();
        } else {
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
      const actual =
        input.tagName === "TEXTAREA" || input.tagName === "INPUT"
          ? input.value
          : input.innerText || input.textContent || "";
      if (!actual.trim()) {
        console.warn(
          "[BiliTK→DS] 输入框是空的，DeepSeek 可能换了输入框结构",
          input,
        );
      }
      setTimeout(() => {
        simulateSend(input);
        cleanup();
      }, 500);
    };

    timer = setInterval(tryInject, 500);
    tryTimer = setTimeout(tryInject, 1200);
  }

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
#subtitle-setting-panel input[type="range"] { background-color: #ebeff4; -webkit-appearance: none; height:4px; transform: translateY(-4px); }
#subtitle-setting-panel input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; height: 15px; width: 15px; background: #fff; border-radius: 15px; border: 1px solid; }
/*复选框和其对应标签样式*/
#subtitle-setting-panel input[type="checkbox"]{display:none;}
#subtitle-setting-panel input ~ label {cursor:pointer;}
#subtitle-setting-panel input:checked ~ label:before {content: '\\2714';}
#subtitle-setting-panel input ~ label:before{ width: 12px; height:12px; line-height: 14px; vertical-align: text-bottom; border-radius: 3px; border:1px solid #d3d3d3; display: inline-block; text-align: center; content: ' '; }
/*悬停显示下拉框样式*/
#subtitle-setting-panel .bpui-selectmenu:hover .bpui-selectmenu-list{display:block;}
/*滚动条样式*/
#subtitle-setting-panel ::-webkit-scrollbar{width: 7px;}
#subtitle-setting-panel ::-webkit-scrollbar-track{border-radius: 4px;background-color: #EEE;}
#subtitle-setting-panel ::-webkit-scrollbar-thumb{border-radius: 4px;background-color: #999;}
/* 新增：拖动时的样式 */
#subtitle-download-dialog.dragging { cursor: grabbing !important; user-select: none; }
#subtitle-download-dialog.dragging textarea { pointer-events: none; }
/* 新增：复制按钮样式 */
.copy-clipboard-btn { background: #00a1d6 !important; margin-left: 5px; }
.copy-clipboard-btn:hover { background: #00a1d6 !important; }
.copy-success-toast { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(0,0,0,0.8); color: #fff; padding: 20px 40px; border-radius: 8px; font-size: 16px; z-index: 1048577; animation: fadeInOut 2s ease; }
@keyframes fadeInOut { 0% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); } 20% { opacity: 1; transform: translate(-50%, -50%) scale(1); } 80% { opacity: 1; transform: translate(-50%, -50%) scale(1); } 100% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); } }
/* 字幕框右下角的明显缩放手柄 */
.subtitle-textarea-resize-box { position: relative; width: 500px; min-width: 310px; height: 410px; min-height: 180px; max-width: calc(100vw - 40px); max-height: calc(100vh - 170px); }
.subtitle-textarea-resize-box textarea { width: 100% !important; height: 100% !important; box-sizing: border-box; resize: none !important; }
.subtitle-resize-handle { position: absolute; right: 3px; bottom: 3px; width: 28px; height: 28px; border: 2px solid #fff; border-radius: 5px; background: #00a1d6; box-shadow: 0 1px 5px rgba(0,0,0,.35); color: #fff; cursor: nwse-resize; display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: bold; line-height: 1; z-index: 2; user-select: none; }
.subtitle-resize-handle:hover, .subtitle-resize-handle.active { background: #008fbe; transform: scale(1.08); }
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
          { className: "bpui-selectmenu-arrow bpui-icon bpui-icon-arrow-down" },
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
          { className: "bpui-selectmenu-list-row", innerHTML: item.content },
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

  // ============================================================
  // [4.1] utils：统一工具层（DOM / 拖拽 / 剪贴板 / 时间 / Toast / 存储）
  // 依赖方向：任何业务模块 → utils，utils 不依赖业务模块。
  // ============================================================
  const utils = {
    // ---------- DOM ----------
    el(tag, props, parent) {
      const node = document.createElement(tag);
      if (props) Object.assign(node, props);
      if (parent) parent.appendChild(node);
      return node;
    },
    elAt(selector, props, parent) {
      const node = document.body.querySelector(selector);
      if (node && props) Object.assign(node, props);
      if (node && parent) parent.appendChild(node);
      return node;
    },

    // ---------- 拖拽 ----------
    // 统一替换 encoder.initDragging / decoder.initDragging / uiManager.makeDraggable
    // 返回 destroy 函数，供关闭窗口时清理 document 监听器
    makeDraggable(handle, container, opts = {}) {
      let dragging = false,
        offX = 0,
        offY = 0;
      const onDown = (e) => {
        if (
          e.target.closest("button, a, select, input, textarea, [data-no-drag]")
        )
          return;
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        const r = container.getBoundingClientRect();
        offX = e.clientX - r.left;
        offY = e.clientY - r.top;
        handle.style.cursor = "grabbing";
        container.style.transition = "none";
        container.classList.add("dragging");
      };
      const onMove = (e) => {
        if (!dragging) return;
        const x = Math.max(
          0,
          Math.min(e.clientX - offX, window.innerWidth - container.offsetWidth),
        );
        const y = Math.max(
          0,
          Math.min(
            e.clientY - offY,
            window.innerHeight - container.offsetHeight,
          ),
        );
        container.style.left = x + "px";
        container.style.top = y + "px";
        container.style.transform = "none";
        opts.onMove && opts.onMove(x, y);
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        handle.style.cursor = "move";
        container.style.transition = opts.transition || "";
        container.classList.remove("dragging");
        opts.onEnd && opts.onEnd();
      };
      handle.addEventListener("mousedown", onDown);
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      return () => {
        handle.removeEventListener("mousedown", onDown);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
    },

    // ---------- 剪贴板 ----------
    async copy(text) {
      try {
        if (typeof GM_setClipboard === "function") {
          GM_setClipboard(text, "text");
          return true;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
        const ta = Object.assign(document.createElement("textarea"), {
          value: text,
          style: "position:fixed;left:-9999px;top:0;",
        });
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch (e) {
        console.error("[utils.copy]", e);
        return false;
      }
    },

    // ---------- 时间 ----------
    // 统一替换 encoder.encodeTime / formatSubtitleWithTimestamps 内的重复逻辑
    fmtTime(sec, format = "SRT") {
      sec = Math.max(0, Number(sec) || 0);
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.floor(sec % 60);
      const ms = Math.round((sec - Math.floor(sec)) * 1000);
      const p2 = (n) => String(n).padStart(2, "0");
      switch (format) {
        case "SRT":
          return `${p2(h)}:${p2(m)}:${p2(s)},${String(ms).padStart(3, "0")}`;
        case "VTT":
          return `${p2(h)}:${p2(m)}:${p2(s)}.${String(ms).padStart(3, "0")}`;
        case "ASS":
          return `${h}:${p2(m)}:${p2(s)}.${p2(Math.floor(ms / 10))}`;
        case "LRC": {
          const totalMin = m + h * 60;
          return `[${p2(totalMin)}:${p2(s)}.${p2(Math.floor(ms / 10))}]`;
        }
        case "MMSS":
          return h > 0 ? `${p2(h)}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`;
        default:
          return `${sec}`;
      }
    },

    // ---------- Toast ----------
    // 优先转给业务层统一入口，避免 utils → 业务层的硬依赖
    toast(message, type = "success") {
      try {
        if (
          typeof bilibiliCCHelper !== "undefined" &&
          typeof bilibiliCCHelper.toast === "function"
        ) {
          bilibiliCCHelper.toast(message, type === "error" ? true : undefined);
          return;
        }
        if (
          typeof encoder !== "undefined" &&
          typeof encoder.showToast === "function"
        ) {
          encoder.showToast(message, type);
          return;
        }
      } catch (e) {
        console.warn("[utils.toast] 转发失败", e);
      }
      console.warn("[BiliTK toast]", message);
    },

    // ---------- 存储 ----------
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

  // [4.1] uiManager 保留为 utils 的薄包装（少量调用点用到 UI 状态）
  const uiManager = {
    showToast(message, type = "success") {
      utils.toast(message, type);
    },
    saveState(key, state) {
      utils.saveState(key, state);
    },
    loadState(key, defaults) {
      return utils.loadState(key, defaults);
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

  // ============================================================
  // Bilibili WBI 签名（内嵌自 Bilibili WBI Signer Library v1.2.0）
  // 原作者：Kaesinol（https://greasyfork.org/scripts/580254）
  // ============================================================
  const WBI_MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
  ];

  function wbiMd5(message) {
    const buffer = new TextEncoder().encode(message);
    const n = buffer.length;
    const words = new Uint32Array((((n + 8) >> 6) + 1) << 4);
    for (let i = 0; i < n; i++) words[i >> 2] |= buffer[i] << ((i % 4) * 8);
    words[n >> 2] |= 0x80 << ((n % 4) * 8);
    words[words.length - 2] = n * 8;
    let [a, b, c, d] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    const K = Uint32Array.from(
      { length: 64 },
      (_, i) => (Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0,
    );
    const S = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4,
      11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6,
      10, 15, 21,
    ];
    const rotl = (x, k) => (x << k) | (x >>> (32 - k));
    for (let i = 0; i < words.length; i += 16) {
      let [A, B, C, D] = [a, b, c, d];
      for (let j = 0; j < 64; j++) {
        let f, g;
        if (j < 16) {
          f = (B & C) | (~B & D);
          g = j;
        } else if (j < 32) {
          f = (D & B) | (~D & C);
          g = (5 * j + 1) % 16;
        } else if (j < 48) {
          f = B ^ C ^ D;
          g = (3 * j + 5) % 16;
        } else {
          f = C ^ (B | ~D);
          g = (7 * j) % 16;
        }
        const temp = D;
        D = C;
        C = B;
        const x = (A + f + K[j] + words[i + g]) | 0;
        B = (B + rotl(x, S[j])) | 0;
        A = temp;
      }
      a = (a + A) | 0;
      b = (b + B) | 0;
      c = (c + C) | 0;
      d = (d + D) | 0;
    }
    const outBuf = new ArrayBuffer(16);
    const view = new DataView(outBuf);
    [a, b, c, d].forEach((val, i) => view.setUint32(i * 4, val, true));
    return Array.from(new Uint8Array(outBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function wbiGetSignedQuery(params, img_key, sub_key) {
    const orig = img_key + sub_key;
    const mixin_key = WBI_MIXIN_KEY_ENC_TAB.map((n) => orig[n])
      .join("")
      .slice(0, 32);
    const wts = Math.round(Date.now() / 1000);
    const chrFilter = /[!'()*]/g;
    const signedParams = { ...params, wts };
    const query = Object.entries(signedParams)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => {
        const filteredValue = String(value).replace(chrFilter, "");
        return `${encodeURIComponent(key)}=${encodeURIComponent(filteredValue)}`;
      })
      .join("&");
    const wbiSign = wbiMd5(query + mixin_key);
    return `${query}&w_rid=${wbiSign}`;
  }

  // ============================================================
  // [4.2] biliApi：统一 API 层（WBI 签名 + 字幕配置 + 字幕正文）
  // 依赖方向：biliApi → utils，不依赖任何业务模块。
  // 契约：
  //   fetchSubtitleConfig(p) → { subtitles: [{lan, lan_doc, subtitle_url, ...}], allow_submit? }
  //     - subtitles 不含 close / local（由 controller 自行 push）
  //     - subtitle_url 已规范化为可直接 fetch 的字符串
  //   fetchSubtitleBody(url) → { body: [{from, to, content}] }
  //     - HTTP 失败 / 结构错误 都会 throw
  // ============================================================
  const biliApi = {
    _wbiKeys: null,
    _wbiKeysTime: 0,
    _wbiKeysPromise: null,
    _wbiWarned: false,
    WBI_KEYS_TTL: 4 * 60 * 60 * 1000,

    async fetchWbiKeys() {
      const res = await fetch("https://api.bilibili.com/x/web-interface/nav", {
        credentials: "include",
      });
      if (res.status !== 200) {
        throw new Error("nav 接口请求失败: " + res.status);
      }
      const data = await res.json();
      if (!data || !data.data || !data.data.wbi_img) {
        throw new Error("nav 接口返回异常: " + JSON.stringify(data));
      }
      const { img_url, sub_url } = data.data.wbi_img;
      return {
        img_key: img_url.slice(
          img_url.lastIndexOf("/") + 1,
          img_url.lastIndexOf("."),
        ),
        sub_key: sub_url.slice(
          sub_url.lastIndexOf("/") + 1,
          sub_url.lastIndexOf("."),
        ),
      };
    },

    async getWbiKeys() {
      const now = Date.now();
      if (this._wbiKeys && now - this._wbiKeysTime < this.WBI_KEYS_TTL) {
        return this._wbiKeys;
      }
      if (this._wbiKeysPromise) return this._wbiKeysPromise;
      this._wbiKeysPromise = this.fetchWbiKeys()
        .then((keys) => {
          this._wbiKeys = keys;
          this._wbiKeysTime = Date.now();
          return keys;
        })
        .finally(() => {
          this._wbiKeysPromise = null;
        });
      return this._wbiKeysPromise;
    },

    async sign(params) {
      try {
        const { img_key, sub_key } = await this.getWbiKeys();
        return wbiGetSignedQuery(params, img_key, sub_key);
      } catch (e) {
        console.warn("[biliApi] WBI 签名失败，降级为不签名请求", e);
        if (!this._wbiWarned) {
          this._wbiWarned = true;
          utils.toast("⚠️ WBI 签名失败，已降级为不签名请求", "error");
        }
        return Object.entries(params)
          .map(
            ([k, v]) =>
              `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
          )
          .join("&");
      }
    },

    /**
     * 统一获取字幕配置（单集下载 / 批量下载共用）
     * @param {{cid?, ep_id?, aid?, bvid?}} p
     */
    async fetchSubtitleConfig(p) {
      const params = {};
      if (p.cid) params.cid = String(p.cid);
      else if (p.ep_id) params.ep_id = String(p.ep_id);
      if (p.aid) params.aid = String(p.aid);
      else if (p.bvid) params.bvid = String(p.bvid);
      if (!Object.keys(params).length) throw "缺少视频参数";

      // cid 走 WBI 签名；ep_id 走原不签名路径
      let url;
      if (p.cid) {
        const q = await this.sign(params);
        url = `https://api.bilibili.com/x/player/wbi/v2?${q}`;
      } else {
        const q = Object.entries(params)
          .map(
            ([k, v]) =>
              `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
          )
          .join("&");
        url = `https://api.bilibili.com/x/player/v2?${q}`;
      }

      let ret = await fetch(url, { credentials: "include" }).then((r) =>
        r.json(),
      );

      // -404 降级走 APP 字幕接口
      if (ret.code === -404 && p.cid) {
        const dm = p.aid
          ? `aid=${encodeURIComponent(p.aid)}`
          : `bvid=${encodeURIComponent(p.bvid || "")}`;
        ret = await fetch(
          `https://api.bilibili.com/x/v2/dm/view?${dm}&oid=${encodeURIComponent(
            p.cid,
          )}&type=1`,
          { credentials: "include" },
        ).then((r) => r.json());
        if (ret.code !== 0) throw ret.message || "无法读取字幕配置";
        const sub = ret.data?.subtitle || { subtitles: [] };
        sub.subtitles = (sub.subtitles || []).map((it) =>
          it.subtitle_url
            ? {
                ...it,
                subtitle_url: it.subtitle_url.replace(/https?:\/\//, "//"),
              }
            : it,
        );
        return { ...sub, allow_submit: false };
      }

      if (ret.code !== 0 || !ret.data?.subtitle)
        throw ret.message || `读取字幕配置失败（${ret.code}）`;
      return ret.data.subtitle;
    },

    /** 拉取字幕正文（统一 URL 规范化 + res.ok + 结构校验） */
    async fetchSubtitleBody(url) {
      const full = new URL(
        String(url).replace(/^https?:\/\//, "//"),
        location.href,
      ).href;
      const res = await fetch(full);
      if (!res.ok && res.status !== 0) throw `字幕请求失败（${res.status}）`;
      const data = await res.json();
      if (!data || !Array.isArray(data.body)) throw "字幕数据格式错误";
      return data;
    },
  };

  // ============================================================
  // encoder：字幕编码 + 下载/预览窗口 UI
  // [4.1] 拖拽 → utils.makeDraggable
  // [4.1] 复制 → utils.copy
  // [4.1] 时间 → utils.fmtTime
  // 已删除死字段：isDragging / dragOffsetX / dragOffsetY / initDragging / fallbackCopy
  // ============================================================
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
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
      "Style: Default,Segoe UI,48,&H00FFFFFF,&HF0000000,&H00000000,&HF0000000,1,0,0,0,100,100,0,0.00,1,1,3,2,30,30,20,1",
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Actor, MarginL, MarginR, MarginV, Effect, Text",
    ],
    dialogElement: null,
    panelElement: null,
    currentLan: null,
    languageSelect: null,
    languageStatus: null,
    formatSelect: null,
    resizeContainer: null,

    // 统一清理下载窗口：移除 document 监听器、释放 Blob URL、清空引用
    _cleanupDialog() {
      if (typeof this._destroyDrag === "function") {
        this._destroyDrag();
        this._destroyDrag = null;
      }
      if (typeof this._destroyResize === "function") {
        this._destroyResize();
        this._destroyResize = null;
      }
      [this.actionButton, this.openTabButton].forEach((el) => {
        if (el && el.href && el.href.startsWith("blob:")) {
          URL.revokeObjectURL(el.href);
          el.href = "";
        }
      });
      const dialog = this.dialogElement;
      if (dialog && dialog.isConnected) dialog.remove();
      this.dialogElement = null;
      this.panelElement = null;
      this.resizeContainer = null;
      this.textArea = null;
      this.languageSelect = null;
      this.languageStatus = null;
      this.formatSelect = null;
      this.actionButton = null;
      this.openTabButton = null;
      this.batchButton = null;
      this.copyButton = null;
      this.closeButton = null;
      this.refreshButton = null;
    },

    showDialog(data, download, lan) {
      if (!data || !(data.body instanceof Array)) throw "数据错误";

      this._cleanupDialog();

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
          innerHTML: `当前版本：${
            (typeof GM_info != "undefined" && GM_info.script.version) || "1.0"
          }`,
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
      this._destroyResize = this.initTextAreaResize(
        resizeHandle,
        resizeContainer,
        panel,
      );

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
            this._cleanupDialog();
          },
        },
        bottomPanel,
      );
      // [4.1] 拖拽改用 utils.makeDraggable
      this._destroyDrag = utils.makeDraggable(header, panel, {
        transition: "transform 0.2s, left 0.2s, top 0.2s",
      });
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

    initTextAreaResize(handle, container, panel) {
      const minWidth = 310,
        minHeight = 180;
      let resizing = false,
        startX = 0,
        startY = 0,
        startWidth = 0,
        startHeight = 0;
      const onMove = (e) => {
        if (!resizing) return;
        const maxWidth = Math.max(minWidth, window.innerWidth - 40),
          maxHeight = Math.max(minHeight, window.innerHeight - 170);
        const width = Math.max(
            minWidth,
            Math.min(maxWidth, startWidth + e.clientX - startX),
          ),
          height = Math.max(
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
      const onDown = (e) => {
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
      };
      handle.addEventListener("mousedown", onDown);
      return function destroy() {
        resizing = false;
        handle.classList.remove("active");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        handle.removeEventListener("mousedown", onDown);
      };
    },

    // [4.1] 复制改用 utils.copy（保留按钮视觉反馈）
    copyToClipboard() {
      if (!this.textArea) return;
      const text = this.textArea.value;
      if (!text || text.length === 0) {
        this.showToast("没有可复制的内容！", "error");
        return;
      }
      utils.copy(text).then((ok) => {
        if (ok) this.showCopySuccess();
        else this.showToast("❌ 复制失败，请手动复制", "error");
      });
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

    showToast(message, type = "success") {
      const existing = document.querySelector(".copy-success-toast");
      if (existing) existing.remove();
      const toast = elements.createAs(
        "div",
        {
          className: "copy-success-toast",
          innerText: message,
          style: `position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:1048579;background:${
            type === "error" ? "#e85d5d" : "#20b26b"
          };color:#fff;padding:12px 22px;border-radius:6px;font-size:14px;line-height:1.4;box-shadow:0 3px 12px rgba(0,0,0,.28);pointer-events:none;white-space:nowrap;animation:none;`,
        },
        document.body,
      );
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 2000);
    },

    updateDownload(type = "LRC", download) {
      if (!this.textArea || !this.actionButton || !this.openTabButton) return;
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
      [this.actionButton, this.openTabButton].forEach((el) => {
        if (el && el.href && el.href.startsWith("blob:")) {
          URL.revokeObjectURL(el.href);
          el.href = "";
        }
      });
      this.actionButton.classList.remove(
        "bpui-state-disabled",
        "bui-button-disabled",
      );
      blobResult = new Blob([result], {
        type: "text/" + type + ";charset=utf-8",
      });
      this.actionButton.href = URL.createObjectURL(blobResult);
      this.openTabButton.href = URL.createObjectURL(blobResult);
      this.actionButton.download = `${
        bilibiliCCHelper.getInfo("h1Title") || document.title
      }.${type}`;
      if (download) {
        const url = this.actionButton.href;
        this.actionButton.click();
        setTimeout(() => {
          if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
          if (this.closeButton) this.closeButton.click();
        }, 1500);
      }
    },
    encodeToLRC(data) {
      return data
        .map(({ from, to, content }) => {
          return `${this.encodeTime(from, "LRC")} ${content.replace(
            /\n/g,
            " ",
          )}`;
        })
        .join("\r\n");
    },
    encodeToSRT(data) {
      return data
        .map(({ from, to, content }, index) => {
          return `${index + 1}\r\n${this.encodeTime(from)} --> ${this.encodeTime(
            to,
          )}\r\n${content}`;
        })
        .join("\r\n\r\n");
    },
    encodeToVTT(data) {
      return (
        "WEBVTT \r\n\r\n" +
        data
          .map(({ from, to, content }, index) => {
            return `${index + 1}\r\n${this.encodeTime(
              from,
              "VTT",
            )} --> ${this.encodeTime(to, "VTT")}\r\n${content}`;
          })
          .join("\r\n\r\n")
      );
    },
    encodeToASS(data, title = document.title) {
      const head = this.assHead.slice();
      head[1] = `Title: ${title}`;
      return head
        .concat(
          data.map(({ from, to, content }) => {
            return `Dialogue: 0,${this.encodeTime(
              from,
              "ASS",
            )},${this.encodeTime(
              to,
              "ASS",
            )},*Default,NTP,0000,0000,0000,,${content.replace(/\n/g, "\\N")}`;
          }),
        )
        .join("\r\n");
    },
    // [4.1] 时间格式化统一走 utils.fmtTime
    encodeTime(input, format = "SRT") {
      return utils.fmtTime(input, format);
    },
  };

  // ============================================================
  // decoder：本地字幕解码 + 本地字幕选择面板
  // [4.1] 拖拽 → utils.makeDraggable
  // 已删除死字段：isDragging / dragOffsetX / dragOffsetY / dialogMove
  // ============================================================
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
    show(handler) {
      this.statusHandler = handler;
      const playerEl = elements.getAs("#bilibiliPlayer");
      if (!playerEl) {
        bilibiliCCHelper.toast("找不到播放器容器，无法打开本地字幕面板");
        return;
      }
      if (!this.dialog) {
        this.dialog = elements.createAs(
          "div",
          {
            id: "subtitle-local-selector",
            style:
              "position:fixed;z-index:1048576;padding:10px;top:50%;left:calc(50% - 185px);box-shadow: 0 0 4px #e5e9ef;border: 1px solid #e5e9ef;background:white;border-radius:5px;color:#99a2aa",
          },
          playerEl,
        );
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
        this._dragHandle = header;
      } else {
        playerEl.appendChild(this.dialog);
        this.handleSubtitle();
      }
      if (typeof this._destroyDrag === "function") this._destroyDrag();
      // [4.1] 拖拽改用 utils.makeDraggable
      this._destroyDrag = utils.makeDraggable(this._dragHandle, this.dialog);
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

  // ============================================================
  // oldPlayerHelper / player2x / player315 / player314
  // 4 种播放器版本适配（本段未改动逻辑，保留原实现）
  // ============================================================
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
          { style: "cursor:pointer", innerText: "自动缩放" },
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
      delete localItem.dataset.value;
      localItem.classList.remove("bui-select-item-active");
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
    },
    init(subtitle) {
      this.hasSubtitles = subtitle.count;
      this.selectedLan = undefined;
      this.selectedLocal = false;
      this.iconBtn = elements.getAs(".bilibili-player-video-btn-subtitle");
      this.panel = elements.getAs(
        ".bilibili-player-video-subtitle-setting-lan",
      );
      if (!this.iconBtn) throw "找不到新播放器按钮";
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
        this.iconBtn.style.display = "block";
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
        }).observe(this.iconBtn, { childList: true, subtree: true });
      } else {
        throw "找不到新播放器按钮";
      }
    },
  };

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
    },
    init(subtitle) {
      this.panel = elements.getAs(".bpx-player-ctrl-subtitle-major-content");
      if (!this.panel) throw "无字幕";
      this.initUI();
    },
  };

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
    },
    init(subtitle) {
      this.hasSubtitles = subtitle.count;
      this.selectedLan = undefined;
      this.selectedLocal = false;
      this.iconBtn = elements.getAs(".squirtle-subtitle-wrap");
      this.panel = elements.getAs(".squirtle-subtitle-select-list");
      if (!this.iconBtn) throw "找不到新播放器按钮";
      this.icon = this.iconBtn.querySelector(".squirtle-subtitle-icon");
      if (this.panel) this.initUI();
    },
  };

  // ============================================================
  // bilibiliCCHelper：控制器
  // [4.2] WBI + 字幕请求 → biliApi
  // [4.3] 3 个 DeepSeek 发送函数 → _sendToDeepSeek / _deliverToDeepSeek
  // [4.4] getBatchItems 默认值修复
  // [4.5] 抽出 getVideoMarkdownLink，标题+链接统一由它生成
  // 已删除：_asrDsWindow / _wbiKeys / _wbiKeysTime / _wbiKeysPromise /
  //         _wbiWarned / WBI_KEYS_TTL / fetchWbiKeys / getWbiKeys / signWbiQuery
  // ============================================================
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
    _floatBtnHiddenPref: null,

    _asrAbortController: null,
    _asrXHR: null,
    _asrProgressTimer: null,

    DEEPSEEK_WHALE_SVG:
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"></path></svg>',

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

    showProgressUI(message) {
      let el = document.getElementById("cc-progress-ui");
      if (!el) {
        el = document.createElement("div");
        el.id = "cc-progress-ui";
        el.style.cssText =
          "position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.85);color:#fff;padding:12px 24px;border-radius:30px;font-size:14px;z-index:1048579;display:flex;align-items:center;gap:12px;box-shadow:0 4px 16px rgba(0,0,0,0.3);transition:all 0.3s;";
        el.innerHTML = `<div style="width:16px;height:16px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:cc-spin 1s linear infinite;"></div><span id="cc-progress-text">${message}</span><style>@keyframes cc-spin { 100% { transform: rotate(360deg); } }</style>`;
        document.body.appendChild(el);
      } else {
        document.getElementById("cc-progress-text").innerText = message;
      }
    },
    updateProgressUI(message) {
      const textEl = document.getElementById("cc-progress-text");
      if (textEl) textEl.innerText = message;
    },
    hideProgressUI() {
      const el = document.getElementById("cc-progress-ui");
      if (el) el.remove();
    },

    // [4.3] 新增：统一的 DeepSeek 投递入口（存 → 复制 → 打开 tab → 提示）
    async _deliverToDeepSeek(promptText, okMsg) {
      let stored = false;
      try {
        if (typeof GM_setValue === "function") {
          GM_setValue(DS_STORAGE_KEY, { text: promptText, ts: Date.now() });
          stored = true;
        }
      } catch (e) {}
      await utils.copy(promptText);
      if (typeof GM_openInTab !== "undefined") {
        GM_openInTab("https://chat.deepseek.com/", { active: true });
      } else {
        window.open("https://chat.deepseek.com/", "_blank");
      }
      encoder.showToast(
        stored ? okMsg : "✅ 已复制内容并打开 DeepSeek，请粘贴发送",
      );
    },

    // [4.3] 新增：统一的"获取当前视频首选字幕数据"入口
    async _getPreferredSubtitleData() {
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
      return { data, lan };
    },

    // [4.3] 新增：统一的"发送字幕到 DeepSeek"入口（普通 / 带时间戳共用）
    async _sendToDeepSeek({ btn, withTimestamp }) {
      if (btn) {
        btn.style.pointerEvents = "none";
        btn.style.opacity = "0.65";
      }
      try {
        encoder.showToast("正在获取字幕…");
        const { data, lan } = await this._getPreferredSubtitleData();
        // [4.5] 标题 / 链接 / Markdown 文本统一由 getVideoMarkdownLink 生成
        const { title, url } = this.getVideoMarkdownLink();
        const lanDoc = (this.getSubtitleInfo(lan) || {}).lan_doc || lan;
        const meta = `视频标题：${title}\n视频链接：${url}\n字幕语言：${lanDoc}\n字幕条数：${data.body.length}`;
        let prompt;
        if (withTimestamp) {
          const timestamped = this.formatSubtitleWithTimestamps(data.body);
          prompt =
            this.OBSIDIAN_SKILL_PROMPT +
            this.OBSIDIAN_TIMESTAMP_EXTRA +
            `\n\n===== 以下是要处理的视频字幕（每条均带时间戳）=====\n` +
            `${meta}\n\n` +
            timestamped;
        } else {
          const srt = encoder.encodeToSRT(data.body);
          prompt =
            this.OBSIDIAN_SKILL_PROMPT +
            `\n\n===== 以下是要处理的视频字幕 =====\n` +
            `${meta}\n\n` +
            srt;
        }
        await this._deliverToDeepSeek(
          prompt,
          withTimestamp
            ? "✅ 已打开 DeepSeek，正在自动发送带时间戳的字幕…"
            : "✅ 已打开 DeepSeek，正在自动发送字幕…",
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

    // 保留原入口签名，内部走统一流程
    async sendSubtitleToDeepSeek(btn) {
      return this._sendToDeepSeek({ btn, withTimestamp: false });
    },
    async sendSubtitleToDeepSeekWithTimestamps(btn) {
      return this._sendToDeepSeek({ btn, withTimestamp: true });
    },

    async sendLocalAsrToDeepSeekClean(btn) {
      if (!btn) {
        btn = this.localAsrDeepseekButton;
        if (!btn) {
          encoder.showToast("❌ 找不到本地识别按钮", "error");
          return;
        }
      }
      // ================= 取消逻辑 =================
      if (btn.dataset.running === "1") {
        if (this._asrAbortController) {
          this._asrAbortController.abort();
          this._asrAbortController = null;
        }
        if (this._asrXHR && typeof this._asrXHR.abort === "function") {
          this._asrXHR.abort();
        }
        this._asrXHR = null;
        if (this._asrProgressTimer) {
          clearInterval(this._asrProgressTimer);
          this._asrProgressTimer = null;
        }
        this.hideProgressUI();
        if (this._currentTaskId && typeof GM_xmlhttpRequest !== "undefined") {
          GM_xmlhttpRequest({
            method: "POST",
            url: `http://127.0.0.1:8001/api/cancel/${this._currentTaskId}`,
          });
          this._currentTaskId = null;
        }
        btn.dataset.running = "0";
        btn.innerHTML =
          this.DEEPSEEK_WHALE_SVG +
          '<span style="position:absolute;bottom:1px;right:2px;font-size:8px;font-weight:700;line-height:11px;background:#fff;color:#2e7d32;padding:0 3px;border-radius:5px;box-shadow:0 1px 3px rgba(0,0,0,0.25);">本地</span>';
        btn.style.background = "linear-gradient(135deg,#2e7d32,#43a047)";
        encoder.showToast("🛑 已取消本地识别", "error");
        return;
      }

      // ================= 启动逻辑 =================
      btn.dataset.running = "1";
      btn.innerHTML =
        '<span style="font-size:12px;font-weight:bold;">取消</span>';
      btn.style.background = "linear-gradient(135deg,#d32f2f,#e53935)";

      this._asrAbortController = new AbortController();

      try {
        encoder.showToast("正在获取音频流…");

        // 1. 获取视频 bvid 和 cid
        let bvid = this.getBvid();
        let cid = this.cid;
        const win = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
        if (!cid && win.__INITIAL_STATE__?.videoData?.pages) {
          const p = win.__INITIAL_STATE__?.p || 1;
          cid = win.__INITIAL_STATE__.videoData.pages[p - 1].cid;
        }
        if (!bvid || !cid) throw "无法获取视频信息，请刷新页面";

        // 2. 请求 API 获取音频流
        const apiUrl = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16`;
        const playurlResp = await fetch(apiUrl, { credentials: "include" });
        const playurlData = await playurlResp.json();
        let audioUrl = playurlData?.data?.dash?.audio?.[0]?.baseUrl;
        if (!audioUrl) throw "解析音频流失败";

        // 3. 下载音频 Blob
        encoder.showToast("正在下载音频…");
        let audioBlob;
        try {
          const nativeFetch =
            typeof unsafeWindow !== "undefined" && unsafeWindow.fetch
              ? unsafeWindow.fetch
              : window.fetch;
          const resp = await nativeFetch(audioUrl, {
            signal: this._asrAbortController.signal,
          });
          audioBlob = await resp.blob();
        } catch (e) {
          if (e.name === "AbortError") throw "用户取消了下载";
          throw e;
        }

        // 4. 心跳检测
        encoder.showToast("正在检查本地服务状态…");
        let isServerRunning = false;
        try {
          await new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
              method: "GET",
              url: "http://127.0.0.1:8001/docs",
              timeout: 2000,
              onload: () => resolve(),
              onerror: () => reject(),
              ontimeout: () => reject(),
            });
          });
          isServerRunning = true;
        } catch (e) {
          isServerRunning = false;
        }

        // 5. 唤醒本地服务
        if (!isServerRunning) {
          encoder.showToast("正在唤醒本地服务，请在弹出的提示中点击允许…");
          window.open("bili-asr://start", "_blank");

          let wakeSuccess = false;
          for (let i = 0; i < 15; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            if (btn.dataset.running !== "1") throw "用户取消";
            try {
              await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                  method: "GET",
                  url: "http://127.0.0.1:8001/docs",
                  timeout: 1000,
                  onload: () => resolve(),
                  onerror: () => reject(),
                  ontimeout: () => reject(),
                });
              });
              wakeSuccess = true;
              break;
            } catch (e) {
              this.updateProgressUI(`等待本地服务启动… (${(i + 1) * 2}s)`);
            }
          }

          if (!wakeSuccess) {
            throw "❌ 自动唤醒失败，请确认浏览器已允许打开外部应用，或手动运行 server.py";
          }
          encoder.showToast("✅ 服务已成功唤醒");
        }

        // 6. 提交任务
        this.showProgressUI("发送给本地识别中...");
        const formData = new FormData();
        formData.append("file", audioBlob, "audio.m4s");

        const taskId = await new Promise((resolve, reject) => {
          let settled = false;
          const cleanup = () => {
            settled = true;
            this._asrXHR = null;
          };
          const ok = (id) => {
            if (settled) return;
            cleanup();
            resolve(id);
          };
          const fail = (msg) => {
            if (settled) return;
            cleanup();
            reject(new Error(msg));
          };
          this._asrXHR = GM_xmlhttpRequest({
            method: "POST",
            url: "http://127.0.0.1:8001/api/transcribe",
            data: formData,
            timeout: 600000,
            onload: (r) => {
              if (r.status !== 200) return fail(`提交失败（HTTP ${r.status}）`);
              try {
                const id = JSON.parse(r.responseText).task_id;
                if (id == null) return fail("任务响应缺少 task_id");
                ok(id);
              } catch (e) {
                fail("解析任务响应失败");
              }
            },
            onerror: () => fail("无法连接本地服务"),
            ontimeout: () => fail("提交任务超时"),
            onabort: () => fail("用户取消"),
          });
        });

        this._currentTaskId = taskId;

        // 7. 轮询进度
        const text = await new Promise((resolve, reject) => {
          let settled = false;
          let inflight = false;
          let consecutiveFailures = 0;
          const MAX_CONSECUTIVE_FAILURES = 3;

          const stopTimer = () => {
            if (this._asrProgressTimer) {
              clearInterval(this._asrProgressTimer);
              this._asrProgressTimer = null;
            }
          };
          const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            stopTimer();
            fn(arg);
          };
          const ok = (t) => finish(resolve, t);
          const fail = (e) =>
            finish(reject, e instanceof Error ? e : new Error(e));

          this._asrProgressTimer = setInterval(() => {
            if (settled) return;
            if (btn.dataset.running !== "1") {
              return fail(new Error("用户取消"));
            }
            if (inflight) return;
            inflight = true;
            GM_xmlhttpRequest({
              method: "GET",
              url: `http://127.0.0.1:8001/api/progress/${taskId}`,
              timeout: 5000,
              onload: (r) => {
                inflight = false;
                if (settled) return;
                if (r.status !== 200) {
                  if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    return fail(new Error(`进度查询失败（HTTP ${r.status}）`));
                  }
                  return;
                }
                consecutiveFailures = 0;
                let task;
                try {
                  task = JSON.parse(r.responseText);
                } catch (e) {
                  return fail(new Error("解析进度响应失败"));
                }
                if (task.status === "completed") {
                  ok(task.text);
                } else if (task.status === "failed") {
                  fail(new Error(task.message || "识别失败"));
                } else {
                  this.updateProgressUI(`${task.message} (${task.progress}%)`);
                }
              },
              onerror: () => {
                inflight = false;
                if (settled) return;
                if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                  fail(new Error("无法连接本地服务"));
                }
              },
              ontimeout: () => {
                inflight = false;
                if (settled) return;
                if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                  fail(new Error("进度查询超时"));
                }
              },
            });
          }, 1000);
        });

        this.hideProgressUI();
        if (!text || !text.trim()) throw "识别结果为空";

        // 8. 组装 Prompt 并投递
        // [4.5] 标题 / 链接 / Markdown 文本统一由 getVideoMarkdownLink 生成
        const { title, url } = this.getVideoMarkdownLink();
        const prompt =
          this.OBSIDIAN_SKILL_PROMPT +
          `\n\n===== 以下是要处理的视频字幕（由本地语音识别生成）=====\n视频标题：${title}\n视频链接：${url}\n字幕来源：纯本地 SenseVoice 识别（可能有识别错误，请在整理时酌情修正）\n\n` +
          text;

        await this._deliverToDeepSeek(prompt, "✅ 已跳转 DeepSeek 自动发送…");
      } catch (e) {
        console.error("纯本地识别失败", e);
        this.hideProgressUI();
        if (e.message !== "用户取消" && e !== "用户取消") {
          encoder.showToast(`❌ 失败：${e.message || e}`, "error");
        }
      } finally {
        this._currentTaskId = null;
        this._asrAbortController = null;
        if (btn) {
          btn.dataset.running = "0";
          btn.innerHTML =
            this.DEEPSEEK_WHALE_SVG +
            '<span style="position:absolute;bottom:1px;right:2px;font-size:8px;font-weight:700;line-height:11px;background:#fff;color:#2e7d32;padding:0 3px;border-radius:5px;box-shadow:0 1px 3px rgba(0,0,0,0.25);">本地</span>';
          btn.style.background = "linear-gradient(135deg,#2e7d32,#43a047)";
        }
      }
    },

    createFloatingButton() {
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

      this.floatButtonContainer = elements.createAs(
        "div",
        {
          id: "cc-subtitle-float-container",
          style:
            "position:fixed;top:110px;right:24px;z-index:1048577;display:flex;flex-direction:column;gap:8px;",
        },
        document.body,
      );

      if (!document.getElementById("cc-float-btn-style")) {
        elements.createAs(
          "style",
          {
            id: "cc-float-btn-style",
            innerHTML:
              "#cc-subtitle-float-container>div{transition:transform .15s,box-shadow .15s,opacity .2s,filter .2s;}" +
              "#cc-subtitle-float-container>div.cc-float-btn-disabled{opacity:.38!important;filter:grayscale(1)!important;cursor:not-allowed!important;box-shadow:0 2px 6px rgba(0,0,0,.15)!important;}" +
              "#cc-subtitle-float-container>div.cc-float-btn-disabled:hover{transform:none!important;box-shadow:0 2px 6px rgba(0,0,0,.15)!important;}",
          },
          document.head,
        );
      }

      // 1. 字幕批量下载
      this.subtitleBatchButton = elements.createAs(
        "div",
        {
          id: "cc-subtitle-batch-trigger",
          style:
            "width:44px;height:44px;background:linear-gradient(135deg,#00a1d6,#00b5e5);border-radius:12px;box-shadow:0 4px 14px rgba(0,161,214,0.35);cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;user-select:none;-webkit-tap-highlight-color:transparent;transition:transform .15s, box-shadow .15s;",
          innerHTML:
            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
          title: "字幕批量下载 — 左键打开，右键设置",
          onmouseenter: function () {
            this.style.transform = "scale(1.1)";
            this.style.boxShadow = "0 6px 20px rgba(0,161,214,0.55)";
          },
          onmouseleave: function () {
            this.style.transform = "scale(1)";
            this.style.boxShadow = "0 4px 14px rgba(0,161,214,0.35)";
          },
          onclick: self.guardSubtitleAction(function () {
            self.openDownloadDialog();
          }),
          oncontextmenu: function (e) {
            e.preventDefault();
            e.stopPropagation();
            self.showFloatingButtonMenu(e.clientX, e.clientY);
            return false;
          },
        },
        this.floatButtonContainer,
      );

      // 2. 一键复制 SRT
      this.copyFloatButton = elements.createAs(
        "div",
        {
          id: "cc-subtitle-copy-trigger",
          style:
            "width:44px;height:44px;background:linear-gradient(135deg,#20b26b,#27c97a);border-radius:12px;box-shadow:0 4px 14px rgba(32,178,107,0.35);cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;user-select:none;-webkit-tap-highlight-color:transparent;transition:transform .15s, box-shadow .15s;",
          innerHTML:
            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
          title: "一键复制当前视频的 SRT 字幕",
          onmouseenter: function () {
            this.style.transform = "scale(1.1)";
            this.style.boxShadow = "0 6px 20px rgba(32,178,107,0.55)";
          },
          onmouseleave: function () {
            this.style.transform = "scale(1)";
            this.style.boxShadow = "0 4px 14px rgba(32,178,107,0.35)";
          },
          onclick: self.guardSubtitleAction(function () {
            self.copyCurrentSubtitleSRT(this);
          }),
        },
        this.floatButtonContainer,
      );

      // 3. 复制标准视频链接
      this.copyLinkButton = elements.createAs(
        "div",
        {
          id: "cc-copy-link-trigger",
          style:
            "width:44px;height:44px;background:linear-gradient(135deg,#ff9800,#ffb74d);border-radius:12px;box-shadow:0 4px 14px rgba(255,152,0,0.35);cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;user-select:none;-webkit-tap-highlight-color:transparent;transition:transform .15s, box-shadow .15s;",
          innerHTML:
            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
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

      // 4. 复制 Markdown 链接
      this.copyMdLinkButton = elements.createAs(
        "div",
        {
          id: "cc-copy-md-link-trigger",
          style:
            "width:44px;height:44px;background:linear-gradient(135deg,#9c27b0,#b968c7);border-radius:12px;box-shadow:0 4px 14px rgba(156,39,176,0.35);cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;position:relative;user-select:none;-webkit-tap-highlight-color:transparent;transition:transform .15s, box-shadow .15s;",
          innerHTML:
            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>' +
            '<span style="position:absolute;bottom:2px;right:2px;font-size:8px;font-weight:700;line-height:11px;letter-spacing:-0.2px;background:#fff;color:#9c27b0;padding:0 3px;border-radius:5px;box-shadow:0 1px 3px rgba(0,0,0,0.25);">MD</span>',
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

      // 5. 发送在线字幕到 DeepSeek
      this.deepseekFloatButton = elements.createAs(
        "div",
        {
          id: "cc-subtitle-deepseek-trigger",
          style:
            "width:44px;height:44px;background:linear-gradient(135deg,#4d6bfe,#6b83ff);border-radius:12px;box-shadow:0 4px 14px rgba(77,107,254,0.35);cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:15px;letter-spacing:.5px;font-family:Arial,sans-serif;user-select:none;-webkit-tap-highlight-color:transparent;transition:transform .15s, box-shadow .15s;",
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
          onclick: self.guardSubtitleAction(function () {
            self.sendSubtitleToDeepSeek(this);
          }),
        },
        this.floatButtonContainer,
      );

      // 6. 发送在线字幕到 DeepSeek（带时间戳）
      this.deepseekTimestampButton = elements.createAs(
        "div",
        {
          id: "cc-subtitle-deepseek-ts-trigger",
          style:
            "width:44px;height:44px;background:linear-gradient(135deg,#2b3cc9,#4d6bfe);border-radius:12px;box-shadow:0 4px 14px rgba(43,60,201,0.4);cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;position:relative;user-select:none;-webkit-tap-highlight-color:transparent;transition:transform .15s, box-shadow .15s;",
          innerHTML:
            this.DEEPSEEK_WHALE_SVG +
            '<span style="position:absolute;bottom:2px;right:3px;font-size:9px;font-weight:700;background:#ffd54f;color:#1e2f9c;padding:0 3px;border-radius:6px;line-height:12px;">T</span>',
          title: "把字幕发送给 DeepSeek，并在笔记中标注时间戳，方便回看视频",
          onmouseenter: function () {
            this.style.transform = "scale(1.1)";
            this.style.boxShadow = "0 6px 20px rgba(43,60,201,0.6)";
          },
          onmouseleave: function () {
            this.style.transform = "scale(1)";
            this.style.boxShadow = "0 4px 14px rgba(43,60,201,0.4)";
          },
          onclick: self.guardSubtitleAction(function () {
            self.sendSubtitleToDeepSeekWithTimestamps(this);
          }),
        },
        this.floatButtonContainer,
      );

      // 7. 本地识别字幕发送到 DeepSeek（走 8001）
      this.localAsrDeepseekButton = elements.createAs(
        "div",
        {
          id: "cc-subtitle-local-asr-deepseek-trigger",
          style:
            "width:44px;height:44px;background:linear-gradient(135deg,#2e7d32,#43a047);border-radius:12px;box-shadow:0 4px 14px rgba(46,125,50,0.4);cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;position:relative;user-select:none;-webkit-tap-highlight-color:transparent;transition:transform .15s, box-shadow .15s;",
          innerHTML:
            this.DEEPSEEK_WHALE_SVG +
            '<span style="position:absolute;bottom:1px;right:2px;font-size:8px;font-weight:700;line-height:11px;background:#fff;color:#2e7d32;padding:0 3px;border-radius:5px;box-shadow:0 1px 3px rgba(0,0,0,0.25);">本地</span>',
          title:
            "用本地 SenseVoice 识别字幕，然后发送给 DeepSeek 整理成笔记\n（需要先在本地运行 bili-tk-voice）",
          onmouseenter: function () {
            this.style.transform = "scale(1.1)";
            this.style.boxShadow = "0 6px 20px rgba(46,125,50,0.6)";
          },
          onmouseleave: function () {
            this.style.transform = "scale(1)";
            this.style.boxShadow = "0 4px 14px rgba(46,125,50,0.4)";
          },
          onclick: function () {
            self.sendLocalAsrToDeepSeekClean(this);
          },
        },
        this.floatButtonContainer,
      );

      this.applyFloatingButtonVisibility();
      this.updateFloatButtonsAvailability(this.subtitle);
    },

    hasAvailableSubtitle(subtitle) {
      if (!subtitle || !Array.isArray(subtitle.subtitles)) return false;
      return subtitle.subtitles.some(
        (item) => item.lan !== "close" && item.lan !== "local",
      );
    },

    guardSubtitleAction(handler) {
      return function (ev) {
        if (this.dataset.disabled === "1") {
          ev && ev.stopPropagation && ev.stopPropagation();
          if (typeof encoder !== "undefined" && encoder.showToast) {
            encoder.showToast("当前视频没有可用字幕", "error");
          }
          return;
        }
        return handler.call(this, ev);
      };
    },

    updateFloatButtonsAvailability(subtitle) {
      if (!subtitle) return;
      const hasSubtitle = this.hasAvailableSubtitle(subtitle);
      const buttons = [
        this.subtitleBatchButton,
        this.copyFloatButton,
        this.deepseekFloatButton,
        this.deepseekTimestampButton,
      ].filter(Boolean);
      buttons.forEach((btn) => {
        if (!btn.dataset.originalTitle) {
          btn.dataset.originalTitle = btn.title || "";
        }
        if (hasSubtitle) {
          btn.classList.remove("cc-float-btn-disabled");
          btn.style.opacity = "";
          btn.style.filter = "";
          btn.style.cursor = "";
          btn.dataset.disabled = "0";
          btn.title = btn.dataset.originalTitle;
        } else {
          btn.classList.add("cc-float-btn-disabled");
          btn.style.opacity = "0.38";
          btn.style.filter = "grayscale(1)";
          btn.style.cursor = "not-allowed";
          btn.dataset.disabled = "1";
          btn.title = "当前视频没有可用字幕";
        }
      });
    },

    isWebFullscreen() {
      if (document.fullscreenElement) return true;
      const bpx = document.querySelector(".bpx-player-container");
      if (bpx) {
        const screen = bpx.getAttribute("data-screen");
        if (screen === "web" || screen === "full") return true;
      }
      if (
        document.querySelector(
          ".bilibili-player.bilibili-player-fullscreen, .bilibili-player-video-web-fullscreen",
        )
      )
        return true;
      const cls = document.body?.classList;
      const htmlCls = document.documentElement?.classList;
      if (cls) {
        if (
          cls.contains("player-fullscreen") ||
          cls.contains("bpx-player-fullscreen") ||
          cls.contains("bilibili-player-fullscreen")
        )
          return true;
      }
      if (htmlCls) {
        if (
          htmlCls.contains("player-fullscreen") ||
          htmlCls.contains("bpx-player-fullscreen")
        )
          return true;
      }
      return false;
    },

    getFloatingButtonHiddenPref() {
      if (this._floatBtnHiddenPref === null) {
        const state = uiManager.loadState(this.floatButtonPrefKey, {
          hidden: false,
        });
        this._floatBtnHiddenPref = !!state.hidden;
      }
      return this._floatBtnHiddenPref;
    },
    setFloatingButtonHiddenPref(hidden) {
      this._floatBtnHiddenPref = !!hidden;
      uiManager.saveState(this.floatButtonPrefKey, { hidden: !!hidden });
    },

    applyFloatingButtonVisibility() {
      if (!this.floatButtonContainer) return;
      const hidden =
        this.floatButtonHiddenThisPage ||
        this.getFloatingButtonHiddenPref() ||
        this.isWebFullscreen();
      this.floatButtonContainer.style.display = hidden ? "none" : "flex";
    },
    toggleFloatingButtonGlobal() {
      const nextHidden = !this.getFloatingButtonHiddenPref();
      this.setFloatingButtonHiddenPref(nextHidden);
      this.floatButtonHiddenThisPage = false;
      this.applyFloatingButtonVisibility();
      this.toast(nextHidden ? "悬浮按钮已关闭" : "悬浮按钮已打开");
    },
    hideFloatingButtonTemporarily() {
      this.floatButtonHiddenThisPage = true;
      this.applyFloatingButtonVisibility();
      this.toast("悬浮按钮已临时关闭");
    },
    hideFloatingButtonPermanently() {
      this.setFloatingButtonHiddenPref(true);
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
        const lan =
          encoder.currentLan &&
          languages.some((item) => item.lan === encoder.currentLan)
            ? encoder.currentLan
            : languages[0].lan;
        const data = await this.getSubtitle(lan);
        if (!data || !Array.isArray(data.body) || !data.body.length)
          throw "字幕内容为空";
        const srt = encoder.encodeToSRT(data.body);
        const ok = await utils.copy(srt);
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

    getStandardVideoUrl() {
      const pathname = location.pathname;
      const search = location.search;
      let m = pathname.match(/\/(bangumi|cheese)\/play\/ep(\d+)/i);
      if (m)
        return `https://www.bilibili.com/${m[1].toLowerCase()}/play/ep${m[2]}`;
      m = pathname.match(/\/(bangumi|cheese)\/play\/ss(\d+)/i);
      if (m)
        return `https://www.bilibili.com/${m[1].toLowerCase()}/play/ss${m[2]}`;
      const params = new URLSearchParams(search);

      const bvid =
        (pathname.match(/\/video\/(BV[0-9A-Za-z]+)/) || [])[1] ||
        params.get("bvid") ||
        this.getBvid();

      if (bvid) {
        let p = this.window && this.window.__INITIAL_STATE__?.p;
        if (!p) p = +(params.get("p") || 1);
        return (
          `https://www.bilibili.com/video/${bvid}` + (p > 1 ? `?p=${p}` : "")
        );
      }
      return location.origin + pathname;
    },

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

    // [4.5] 统一生成视频的标题 / 标准链接 / Markdown 文本，供多处复用
    // 注意：标题中若含半角 [ ] ( ) 会破坏 Markdown 链接结构，
    // 统一替换为中文全角符号（【 】（ ）），避免排版错乱。
    // 返回的 title 已经是净化后的版本，调用方把它塞进 Prompt 后
    // DeepSeek 也会原样搬进 > 视频：[标题](链接)，同样安全。
    getVideoMarkdownLink() {
      const url = this.getStandardVideoUrl();
      if (!url) throw "无法获取视频链接";
      const safeTitle = String(this.getCleanTitle())
        .replace(/\[/g, "【")
        .replace(/\]/g, "】")
        .replace(/\(/g, "（")
        .replace(/\)/g, "）");
      return { title: safeTitle, url, text: `[${safeTitle}](${url})` };
    },

    async copyVideoLink(btn) {
      if (btn) {
        btn.style.pointerEvents = "none";
        btn.style.opacity = "0.65";
      }
      try {
        const url = this.getStandardVideoUrl();
        if (!url) throw "无法获取视频链接";
        const ok = await utils.copy(url);
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

    // [4.5] 改用 getVideoMarkdownLink，避免重复拼接
    async copyVideoLinkMarkdown(btn) {
      if (btn) {
        btn.style.pointerEvents = "none";
        btn.style.opacity = "0.65";
      }
      try {
        const { text } = this.getVideoMarkdownLink();
        const ok = await utils.copy(text);
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

    OBSIDIAN_SKILL_PROMPT: `你是一个帮助用户整理视频内容的助手。用户会给你一段视频字幕，你需要根据字幕总结视频内容，写成能直接粘贴进 Obsidian 笔记的 Markdown 正文。

【硬性要求，必须使用在线搜索严格遵守】
1. 字幕预处理：
  1. 语音识别问题：由于字幕通常是 AI 识别的，所以可能会有一些问题，例如脑雾被识别成脑物，收纳篮被识别成收纳栏，Trae Work 变成吹work，WorkBuddy 变成 work body。如果你可以根据上下文肯定字幕一定是写错了，就先更改后再整理。
  2. 翻译问题：部分字幕是翻译自外文的，所以可能有问题，比如 Doom 被翻译成厄运之类的，或者是语句很奇怪，你可以在确保不会产生歧义且不会影响原意的前提下重构句子，让句子变正常。
  3. 必要时，可以索资料，比如Lock sand实际是LocalSend
  4. 注意要整理好英文的格式，比如 local send 应为 LocalSend，rust desk应为 RustDesk
2. 不要编造字幕里没有的信息；字幕里没提的结论、数据、案例一概不要脑补。
3. 如果字幕里出现专有名词、人名、产品名、命令、代码等，请保持原文写法。
4. 不要向用户提问，不要征询用户意见，只输出成品。
5. 直接输出笔记正文，不要有任何开场白、说明或收尾语，例如"以下是我给你整理的笔记""希望对你有帮助"之类的话一律不要出现。
6. 可读性很重要，标题、要点、列表、表格、代码块、Emoji等可以按需使用，以此让层次清晰、笔记易读。
7. 用中文输出；
8. 不要给笔记添加任何标签（Tag），例如 #健身、#Linux、#学习 等一律不要出现；也不要在文末追加标签行。
9. 输出时，不要写诸如 LocalSend（字幕是 lock sand）这样的句段，直接写 LocalSend 就行（除非你非常不确定字幕到底是不是错的）
10. 笔记开头必须原样输出视频信息行，格式严格为：> 视频：[视频标题](视频链接)。其中"视频标题"和"视频链接"必须直接使用输入信息中给出的"视频标题"和"视频链接"的值，不要改写标题、不要修改链接、不要拼接作者或 UP 主信息、不要换成别的标题或链接。示例：
   > 视频：[这个作者居然用豆包做游戏?  ——[ 独游制作#15 ]](https://www.bilibili.com/video/BV1Tfgh68EpD)

【建议的笔记结构（可灵活裁剪，视内容而定）】
# 概要
> 视频：[视频标题](视频链接)
> 视频主题/核心问题（范例：第二故事设计困境、系统叙事、打破规则、开发经验教训）

# 核心内容
- 关键论点 / 知识点
- 最终结论



以下是范例：
# AI 与自媒体：人机协作的实践与思考

> 视频：[这个作者居然用豆包做游戏?  ——[ 独游制作#15 ]](https://www.bilibili.com/video/BV1Tfgh68EpD)
> 主题：AI 时代做视频还需要人吗？如何与 AI 相处？以及字节"吹work AI知识库"实战体验

---

## 一、背景与焦虑

- **现象**：网上大量短剧、直播、美女视频，甚至评论区互动，全部由 AI 生成，真假难辨。
- **AI 内容生产现状**：
  - 文案、配音、画面、剪辑、账号运营均可由 AI 完成。
  - 传统视频制作：写稿 3-4 天，后期剪辑 4 天，复杂片子拍摄 7 天、写稿 3 天、后期 20 天。
  - AI 知识区视频：一个人、一台电脑、一天可生产几十条，质量还不差。
- **UP主的恐慌**：
  - 不用 AI，效率拼不过别人。
  - 用 AI，担心内容变成标准答案，观点平均，人会不会"用废"。

## 二、核心问题：把什么交给 AI，什么留给自己？

- **AI 的本质**：概率计算，从已有信息中找共性，给出最稳妥、不出错的答案。
- **好内容需要**：人的选择、判断、与现有内容的差异。
- **人机协作原则**：
  - **AI 负责扩大可能性、激发问题**。
  - **人负责做出判断、决定相信什么、表达什么**。
  - AI 是站在旁边的"他者"，不是直接给答案的先知。

## 三、Trae Work AI知识库：是什么？

字节跳动旗下官方 AI 知识库，解决"AI 很强但不知道怎么用"的问题。

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
  3. 让 AI 总结适合"阿泰"视频的选题判断标准（反直觉、悬念性、争议空间、产业链可拆解、深度数据实测、可支撑性）。
  4. 让 AI 给每个选题打分，筛选出得分最高的 3-5 个，输出标题雏形、一句话钩子、核心矛盾、大众入口、可深挖知识增量。
  5. 做成定时任务，每晚十点自动推送。
- **结果**：得到一台"每天准时上菜的阿泰选题雷达"，稳定产出候选选题。

### 2. 选题体检器（进一步筛选）

- **流程**：
  1. 将选题拆成 3-5 个核心问题。
  2. 整理数据、案例和观点，标注信息来源与可信度。
  3. 站在反方给逻辑和证据挑漏洞。
- **成果**：生成研究底稿，含思维导图、数据表，指出关键盲区，重新定义选题。
  案例：选题"网吧为什么又活过来了" → 快速生成底稿，判断是否值得做。

### 3. 代码审查 skill

- **问题**：不懂编程，AI 给代码声称算出了结果，但无法判断真伪。
- **解决**：知识库推荐"代码审查 skill"，AI 写出代码后可调用该 skill 审查，找出 bug 和质量问题。

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

- **systematic debugging**：让 debug 从"问 AI 你错哪了"转变为系统性排查，三次修不好自动质疑思路，重新换方案。
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







# 健身的"少即是多"：做得少反而更自律

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
- 赶着做下一组的人只是累而已，却把这叫做"强度"。
- 看起来毫不费力，其实是"偷懒式聪明"。

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
- 7-8 小时睡眠是最"懒"的增肌方法，效果胜过任何补剂。
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
-   **本质**：不是意志力差，而是大脑被多巴胺劫持。短视频等高频刺激**调高了大脑的"刺激阈值"**，使其对低刺激的普通活动失去兴趣。
-   **解法**：不用意志力硬扛，而是给大脑一个**真实的"平替"**——能带来踏实满足感和长期回报的事。

## 九件高回报小事清单

### 1. 🚶‍♀️ 出门散步
-   **原理**：斯坦福大学研究发现，走路能**提升创造力81%**，激活大脑产生灵感和整合记忆的"默认模式网络"。
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
-   **原理**：每次学会新东西，大脑都会经历微量的"突触重塑"，这是智识增长的底层机制。
-   **做法**：花5-10分钟，学一个单词、一段历史或一个吉他和弦。

### 7. 💌 发一条真诚的消息
-   **原理**：哈佛大学长达75年的幸福研究核心结论：**良好的人际关系是幸福感最重要的来源**。深度关系靠小温度点滴积累。
-   **做法**：真诚地想到一个人，发一句真心想说的话，而非群发。

### 8. ✅ 做一件拖延很久的小事
-   **原理**：心理学中的"蔡格尼克效应"指出，未完成的事会在潜意识里**持续消耗心理能量**。
-   **做法**：把那件悬而未决的小事（回邮件、预约、还东西）做掉，如释重负。

### 9. 🧘 静坐5分钟
-   **原理**：麻省理工的神经科学研究发现，大脑在安静休息时会进行深度的记忆整合和信息处理，这是手机给不了的真正恢复。
-   **做法**：坐下来，闭上眼，允许思绪自然流动，不需要任何技巧，只是安静地待5分钟。

## 总结

这九件事的共同点是，它们提供的满足感是**真实、累积、内化**的，与手机带来的短暂刺激后的空虚截然不同。下次不想又不知做什么时，从这里挑一件就行。你只需要改变今天一次，这一次就是开始。
`,

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

    // [4.1] 时间戳格式化统一走 utils.fmtTime(sec, "MMSS")
    formatSubtitleWithTimestamps(body) {
      return body
        .map(({ from, content }) => {
          const time = utils.fmtTime(from, "MMSS");
          return `[${time}] ${String(content || "").replace(/\n/g, " ")}`;
        })
        .join("\n");
    },

    // [4.1] 剪贴板统一走 utils.copy（保留方法名，避免大量调用点修改）
    copyTextToClipboard(text) {
      return utils.copy(text);
    },

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
      addItem("本地识别字幕并发送 DeepSeek", () =>
        this.sendLocalAsrToDeepSeekClean(this.localAsrDeepseekButton),
      );
      addItem("临时关闭悬浮按钮（本页）", () =>
        this.hideFloatingButtonTemporarily(),
      );
      addItem("永久关闭悬浮按钮", () => this.hideFloatingButtonPermanently());

      const width = 210,
        height = 122 + 36 * 5;
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

    // [4.4] 修复：defaults 只继承 aid（保证请求参数完整），绝不继承 bvid / cid / ep_id
    getBatchItems() {
      const state = this.window.__INITIAL_STATE__ || {};
      const videoData = state.videoData || this.getInfo("videoData") || {};
      const current = {
        bvid: this.getBvid(),
        aid: this.getAid(),
        cid: this.cid,
        ep_id: this.epid,
        title: this.getInfo("h1Title") || document.title,
      };
      const inherited = { aid: current.aid };
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
            inherited,
          ),
        )
        .filter(Boolean);
      const domItems = unique(domEpisodes);
      if (domItems.length)
        return { label: `播放器选集（${domItems.length}集）`, items: domItems };

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
          .map((item, index) => normalize(item, index, inherited))
          .filter(Boolean),
      );
      if (collectionItems.length)
        return {
          label: `合集（${collectionItems.length}集）`,
          items: collectionItems,
        };

      const pages = videoData.pages || state.pages || [];
      const pageItems = Array.isArray(pages)
        ? unique(
            pages
              .map((item, index) => normalize(item, index, inherited))
              .filter(Boolean),
          )
        : [];
      if (pageItems.length)
        return {
          label: `当前视频选集（${pageItems.length}集）`,
          items: pageItems,
        };

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
              .map((item, index) => normalize(item, index, inherited))
              .filter(Boolean),
          )
        : [];
      if (seasonItems.length)
        return {
          label: `合集/选集（${seasonItems.length}集）`,
          items: seasonItems,
        };

      const currentItem = normalize(current, 0, {});
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
    // [4.2] 走 biliApi.fetchSubtitleConfig，只过滤掉无 subtitle_url 的项
    async fetchBatchSubtitleConfig(item) {
      const config = await biliApi.fetchSubtitleConfig({
        cid: item.cid,
        aid: item.aid,
        bvid: item.bvid,
        ep_id: item.ep_id,
      });
      const subtitles = (config.subtitles || []).filter(
        (info) => info.subtitle_url,
      );
      if (!subtitles.length) throw "该集没有可下载字幕";
      return { subtitles };
    },
    // [4.2] 走 biliApi.fetchSubtitleBody（URL 规范化 + res.ok + 结构校验统一）
    async fetchBatchSubtitle(item, language) {
      const config = await this.fetchBatchSubtitleConfig(item);
      const info =
        language === "__auto__"
          ? config.subtitles[0]
          : config.subtitles.find((subtitle) => subtitle.lan === language);
      if (!info) throw `没有语言为"${language}"的字幕`;
      const data = await biliApi.fetchSubtitleBody(info.subtitle_url);
      return { data, language: info.lan_doc || info.lan };
    },
    encodeBatchSubtitle(data, type, title) {
      switch (String(type).toUpperCase()) {
        case "ASS":
          return encoder.encodeToASS(data.body, title);
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

    async startBatchDownload(items, language, type, status, startButton) {
      if (startButton.dataset.busy === "1") return;
      startButton.dataset.busy = "1";
      startButton.style.opacity = "0.65";
      startButton.style.pointerEvents = "none";
      const CONCURRENCY = 4;
      const MAX_RETRY = 2;
      const RETRY_DELAY = 500;
      const entries = [];
      const failed = [];
      let completedCount = 0;

      const fetchWithRetry = async (item) => {
        let lastErr;
        for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
          try {
            return await this.fetchBatchSubtitle(item, language);
          } catch (e) {
            lastErr = e;
            if (attempt < MAX_RETRY)
              await new Promise((r) => setTimeout(r, RETRY_DELAY));
          }
        }
        throw lastErr;
      };

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
              name: `${String(index + 1).padStart(2, "0")}_${this.safeBatchName(
                item.title,
              )}.${extension}`,
              content: this.encodeBatchSubtitle(result.data, type, item.title),
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

      elements.createAs(
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
      elements.createAs(
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
    // [4.2] 走 biliApi.fetchSubtitleBody（URL 规范化 + res.ok + 结构校验统一）
    async getSubtitle(lan, name) {
      if (this.datas[lan]) return this.datas[lan];
      const item = this.getSubtitleInfo(lan, name);
      if (!item) throw "找不到所选语言字幕" + lan;
      if (this.datas[item.lan]) return this.datas[item.lan];
      const data = await biliApi.fetchSubtitleBody(item.subtitle_url);
      this.datas[item.lan] = data;
      return data;
    },
    getSubtitleInfo(lan, name) {
      return this.subtitle.subtitles.find(
        (item) => item.lan == lan || item.lan_doc == name,
      );
    },
    getInfo(name) {
      const w = this.window;
      if (w[name] != null) return w[name];
      const s = w.__INITIAL_STATE__;
      if (s) {
        if (s[name] != null) return s[name];
        if (s.epInfo?.[name] != null) return s.epInfo[name];
        if (s.videoData?.[name] != null) return s.videoData[name];
      }
      return undefined;
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

    getBvid() {
      return this.getInfo("bvid") || this.bvid;
    },
    getAid() {
      return this.getInfo("aid") || this.aid;
    },

    setupData(force) {
      const currentPcid = this.getEpInfo();
      if (this.subtitle && this.pcid == currentPcid && !force)
        return Promise.resolve(this.subtitle);
      if (
        !force &&
        this._setupPromise &&
        this._setupPromisePcid === currentPcid
      )
        return this._setupPromise;
      const p = this._setupDataImpl(force);
      this._setupPromise = p;
      this._setupPromisePcid = currentPcid;
      p.finally(() => {
        if (this._setupPromise === p) {
          this._setupPromise = null;
          this._setupPromisePcid = null;
        }
      });
      return p;
    },

    // [4.2] 走 biliApi.fetchSubtitleConfig；WBI/-404/URL 规范化全部内聚到 biliApi
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

      // 清掉在线字幕缓存，保留本地字幕
      const prevLocal = this.datas?.local || { body: [] };
      this.datas = { close: { body: [] }, local: prevLocal };
      decoder.data = undefined;

      const config = await biliApi.fetchSubtitleConfig({
        cid: this.cid,
        aid: this.aid,
        bvid: this.bvid,
        ep_id: this.epid,
      });

      const online = config.subtitles || [];
      this.subtitle = {
        count: online.length,
        subtitles: [
          ...online,
          { lan: "close", lan_doc: "关闭" },
          { lan: "local", lan_doc: "本地字幕" },
        ],
      };
      if (config.allow_submit !== undefined) {
        this.subtitle.allow_submit = config.allow_submit;
      }
      return this.subtitle;
    },

    tryInit() {
      clearTimeout(this._initDebounce);
      this._initDebounce = setTimeout(() => {
        this.setupData()
          .then((subtitle) => {
            this.updateFloatButtonsAvailability(subtitle);
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

      let pendingSync = false;
      const syncFloatVisibility = () => {
        if (pendingSync) return;
        pendingSync = true;
        requestAnimationFrame(() => {
          pendingSync = false;
          this.applyFloatingButtonVisibility();
        });
      };

      document.addEventListener("fullscreenchange", syncFloatVisibility);
      document.addEventListener("webkitfullscreenchange", syncFloatVisibility);

      const attrFilter = {
        attributes: true,
        attributeFilter: ["class", "data-screen"],
      };
      new MutationObserver(syncFloatVisibility).observe(document.body, {
        ...attrFilter,
        subtree: true,
      });
      new MutationObserver(syncFloatVisibility).observe(
        document.documentElement,
        attrFilter,
      );

      new MutationObserver((mutations, observer) => {
        for (const mutation of mutations) {
          if (!mutation.target) continue;
          if (
            mutation.target.getAttribute("stage") == 1 ||
            mutation.target.classList.contains("bpx-player-subtitle-wrap") ||
            mutation.target.classList.contains("tit") ||
            mutation.target.classList.contains(
              "bpx-player-ctrl-subtitle-bilingual",
            ) ||
            mutation.target.classList.contains("squircle-quality-wrap") ||
            mutation.target.classList.contains("squirtle-quality-wrap")
          ) {
            this.tryInit();
            break;
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    },
  };
  bilibiliCCHelper.init();
})();
