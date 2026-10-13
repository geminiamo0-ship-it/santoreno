import { css } from "lit";

export const widgetStyles = css`
  :host {
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 2147483000;
    font:
      14px/1.5 ui-sans-serif,
      system-ui,
      -apple-system,
      sans-serif;
    color: #202932;
    direction: ltr;
    pointer-events: none;
    color-scheme: light;
  }
  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }
  button,
  select,
  textarea {
    font: inherit;
  }
  button {
    cursor: pointer;
  }
  button:focus-visible,
  select:focus-visible {
    outline: 3px solid #ab8b60;
    outline-offset: 3px;
  }
  .launcher {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    border: 1px solid #c5a474;
    border-radius: 999px;
    background: #252c35;
    color: #fffaf2;
    padding: 13px 18px;
    font-weight: 700;
    box-shadow: 0 12px 34px rgb(0 0 0 / 18%);
    min-height: 50px;
  }
  .launcher-mark {
    display: grid;
    place-items: center;
    background: #c5a474;
    color: #242a30;
    width: 27px;
    height: 27px;
    border-radius: 50%;
    font-weight: 800;
  }
  .panel {
    pointer-events: auto;
    width: min(400px, calc(100vw - 32px));
    height: min(650px, calc(100dvh - 100px));
    display: flex;
    flex-direction: column;
    background: #fffdfa;
    border: 1px solid #e1d8c9;
    border-radius: 18px;
    box-shadow: 0 18px 64px rgb(18 30 42 / 25%);
    overflow: hidden;
    margin-bottom: 12px;
  }
  .panel.fullscreen {
    position: fixed;
    inset: 16px;
    margin: 0;
    height: auto;
    width: auto;
    border-radius: 16px;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    background: #252c35;
    color: #fffaf2;
    padding: 15px 17px;
  }
  .header-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    font-size: 16px;
    line-height: 1.3;
    font-weight: 750;
  }
  .caption {
    color: #ddd0bd;
    font-size: 11px;
  }
  .header-actions {
    display: flex;
    gap: 6px;
    flex: none;
  }
  .icon-button {
    border: 0;
    background: rgb(255 255 255 / 12%);
    color: inherit;
    border-radius: 9px;
    width: 35px;
    height: 35px;
    display: grid;
    place-items: center;
    font-size: 17px;
  }
  .controls {
    display: flex;
    gap: 10px;
    padding: 11px 16px;
    align-items: center;
    border-bottom: 1px solid #ede7dc;
    color: #4e5b64;
    font-size: 12px;
  }
  select {
    flex: 1;
    min-width: 0;
    background: #fff;
    color: #28333d;
    border: 1px solid #d8cfc0;
    border-radius: 8px;
    padding: 7px 9px;
  }
  .messages {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .empty {
    max-width: 290px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 11px;
    text-align: center;
  }
  .empty-icon {
    background: #f1e7d7;
    color: #7e633e;
    font-size: 24px;
    width: 54px;
    height: 54px;
    display: grid;
    place-items: center;
    border-radius: 16px;
  }
  .empty h2 {
    margin: 0;
    font-size: 19px;
    letter-spacing: -0.025em;
  }
  .empty p {
    margin: 0;
    color: #61707d;
    line-height: 1.6;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #6c5740;
    background: #faf3e9;
    border-top: 1px solid #efe6d9;
    padding: 10px 16px;
    font-size: 12px;
  }
  .status-dot {
    width: 7px;
    height: 7px;
    background: #a17c47;
    border-radius: 50%;
  }
  .composer {
    padding: 12px 14px;
    background: #fff;
  }
  .composer textarea {
    width: 100%;
    resize: none;
    min-height: 58px;
    padding: 10px 12px;
    border: 1px solid #d8cfc0;
    border-radius: 12px;
    background: #f7f5f1;
    color: #75808a;
  }
  .footer {
    color: #87919a;
    font-size: 10px;
    text-align: center;
    padding-top: 7px;
  }
  @media (max-width: 540px) {
    :host {
      right: 12px;
      bottom: 12px;
    }
    .panel {
      width: calc(100vw - 24px);
      height: min(580px, calc(100dvh - 90px));
    }
    .panel.fullscreen {
      inset: 0;
      border-radius: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      scroll-behavior: auto !important;
      transition: none !important;
    }
  }
  .transcript {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 19px;
  }
  .turn {
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-wrap: anywhere;
  }
  .question {
    align-self: flex-end;
    max-width: 94%;
    padding: 11px 13px;
    border-radius: 14px 14px 4px 14px;
    background: #ede8de;
    white-space: pre-wrap;
  }
  .answer {
    align-self: stretch;
    padding: 10px 0;
    line-height: 1.65;
  }
  .answer-text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .citation-list {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    margin-top: 11px;
  }
  .citation {
    background: #f9f1e5;
    color: #5e4525;
    border: 1px solid #e6d5bd;
    border-radius: 999px;
    font-size: 12px;
    padding: 6px 10px;
  }
  .pending-message {
    font-size: 12px;
    color: #796b5a;
  }
  .source-details {
    position: relative;
    padding: 13px 16px;
    max-height: 38%;
    overflow: auto;
    background: #f7f1e7;
    border-top: 1px solid #e6d5bd;
    font-size: 12px;
  }
  .source-details strong {
    display: block;
    padding-right: 30px;
  }
  .source-details p {
    margin: 5px 0 8px;
  }
  .source-details img {
    max-height: 180px;
    max-width: 100%;
    border-radius: 8px;
    object-fit: contain;
  }
  .source-close {
    position: absolute;
    right: 12px;
    top: 10px;
    background: #ede2d2;
    border: 0;
    border-radius: 8px;
    width: 28px;
    height: 28px;
  }
  .composer .send {
    display: block;
    margin: 7px 0 0 auto;
    padding: 7px 18px;
    background: #252c35;
    color: #fffaf2;
    border: 0;
    border-radius: 9px;
    font-weight: 650;
  }
  .composer .send:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }
`;
