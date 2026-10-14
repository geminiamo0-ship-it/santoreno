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
    max-width: 85%;
    padding: 12px 16px;
    border-radius: 16px 16px 5px 16px;
    background: #b88a32;
    color: white;
    line-height: 1.7;
    white-space: pre-wrap;
    unicode-bidi: plaintext;
  }
  .answer {
    align-self: stretch;
    padding: 17px;
    border: 1px solid #e9e1d5;
    border-radius: 16px;
    background: #fffdf8;
    box-shadow: 0 8px 28px rgb(65 49 22 / 5%);
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
  /* Santo shares Royal's medical-reading language while keeping its own branding. */
  .medical-markdown {
    white-space: normal;
    overflow-wrap: anywhere;
    font-size: 13px;
    line-height: 1.75;
  }
  .medical-markdown .md-paragraph {
    margin: 0 0 12px;
  }
  .medical-markdown .md-paragraph:last-child {
    margin-bottom: 0;
  }
  .medical-markdown .md-heading {
    margin: 19px 0 9px;
    color: #30271e;
    font-family: Georgia, "Times New Roman", serif;
    font-weight: 700;
    font-size: 16px;
    line-height: 1.45;
  }
  .medical-markdown .md-callout {
    margin: 14px 0;
    padding: 13px 15px;
    border-left: 3px solid #b58b4b;
    background: #faf3e7;
    border-radius: 11px;
    color: #41352a;
  }
  .medical-markdown .md-callout strong {
    display: block;
    margin-bottom: 4px;
    color: #795a31;
  }
  .medical-markdown .md-callout p {
    margin: 0;
  }
  .medical-markdown .md-table-scroll {
    max-width: 100%;
    overflow-x: auto;
    margin: 13px 0 17px;
    border: 1px solid #e5d9c8;
    background: #fff;
    border-radius: 12px;
  }
  .medical-markdown table {
    min-width: 390px;
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    text-align: start;
  }
  .medical-markdown th {
    padding: 10px 12px;
    background: #f4ede2;
    border-bottom: 1px solid #dccdb7;
    color: #4b3b26;
    text-align: start;
    font-weight: 700;
  }
  .medical-markdown td {
    padding: 10px 12px;
    border-bottom: 1px solid #eee6dd;
    vertical-align: top;
  }
  .medical-markdown tr:last-child td {
    border-bottom: none;
  }
  .medical-markdown tbody tr:nth-child(even) {
    background: #fcfaf6;
  }
  .medical-markdown .md-list {
    margin: 7px 0 12px;
    padding-inline-start: 23px;
  }
  .medical-markdown .md-list li {
    padding-inline-start: 3px;
    margin-bottom: 5px;
  }
  .medical-markdown .md-quote {
    border-inline-start: 3px solid #a4855c;
    margin: 12px 0;
    padding: 8px 13px;
    background: #f8f4ed;
  }
  .medical-markdown .md-rule {
    border: 0;
    border-top: 1px solid #e6dbc8;
    margin: 16px 0;
  }
  .medical-markdown code {
    background: #f3ede2;
    border-radius: 4px;
    padding: 1px 4px;
    font:
      0.92em ui-monospace,
      monospace;
  }
  .medical-markdown .md-code-block {
    margin: 13px 0;
    border: 1px solid #e0d4c2;
    border-radius: 10px;
    overflow-x: auto;
    background: #f7f2e8;
  }
  .medical-markdown .md-code-block pre {
    margin: 0;
    padding: 13px;
    white-space: pre;
    overflow-x: auto;
  }
  .medical-markdown .md-code-lang {
    display: block;
    font-size: 10px;
    padding: 5px 13px;
    border-bottom: 1px solid #e0d4c2;
  }
  .answer-footer {
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid #ede5da;
  }
  .answer-mode {
    font-size: 10px;
    font-weight: 650;
    line-height: 1.5;
    color: #827566;
    display: inline-flex;
  }
  .answer-mode.mode-grounded {
    color: #94702d;
  }
  .answer-mode.mode-general {
    color: #596b7a;
  }
  .source-collection {
    margin: 12px 0 0;
    padding: 12px;
    border: 1px solid #e9dac4;
    border-radius: 12px;
    background: #faf6ef;
  }
  .source-collection summary {
    cursor: pointer;
    font-size: 11px;
    font-weight: 700;
    color: #906a31;
    padding: 7px 0;
  }
  .source-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr));
    gap: 9px;
    margin-top: 8px;
  }
  .source-card {
    appearance: none;
    border: 1px solid #e5d7c5;
    border-radius: 12px;
    background: #fffcf7;
    padding: 12px;
    text-align: start;
    color: #282e36;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .source-card:hover {
    border-color: #af8954;
    background: #fff8ed;
  }
  .source-card strong {
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .source-label {
    text-transform: uppercase;
    color: #966d32;
    font-size: 9px;
    letter-spacing: 0.05em;
  }
  .source-meta {
    font-size: 10px;
    color: #746858;
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
  .reader-panel {
    position: fixed;
    right: 18px;
    top: 18px;
    height: min(820px, calc(100dvh - 36px));
    width: min(620px, calc(100vw - 36px));
    display: flex;
    flex-direction: column;
    z-index: 2147483001;
    background: #fffdfa;
    color: #202932;
    border-radius: 16px;
    border: 1px solid #d8cfc0;
    box-shadow: 0 16px 72px rgb(0 0 0 / 28%);
    overflow: hidden;
  }
  .reader-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 15px 18px;
    background: #252c35;
    color: white;
  }
  .reader-head .source-close {
    position: static;
    color: #202932;
  }
  .reader-nav {
    display: flex;
    gap: 12px;
    border-bottom: 1px solid #e6d5bd;
    padding: 10px 18px;
  }
  .reader-nav button {
    border: 0;
    padding: 7px 10px;
    background: #f3eadb;
    border-radius: 8px;
  }
  .reader-body {
    min-height: 0;
    overflow: auto;
    padding: 18px 22px 42px;
  }
  .reader-body h2 {
    margin: 0 0 10px;
    font-size: 21px;
  }
  .reader-body h3 {
    margin: 10px 0;
    font-size: 16px;
  }
  .reader-body p {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.7;
  }
  .reader-meta {
    color: #68747d;
    font-size: 12px;
  }
  .reader-body nav {
    max-height: 125px;
    overflow: auto;
    background: #f7f3ee;
    padding: 8px;
    border-radius: 9px;
  }
  .reader-body nav button {
    display: block;
    border: 0;
    background: transparent;
    padding: 4px 6px;
    text-align: left;
    width: 100%;
  }
  .reader-body section {
    padding: 13px 4px;
    scroll-margin-top: 14px;
  }
  .reader-body section.reader-highlight {
    background: #fff2cc;
    border-left: 4px solid #c49032;
    padding: 12px;
    border-radius: 8px;
  }
  .reader-body img {
    display: block;
    max-width: 100%;
    max-height: 430px;
    object-fit: contain;
    margin-top: 12px;
  }
  .reader-item {
    display: flex;
    flex-direction: column;
    width: 100%;
    text-align: left;
    border: 1px solid #e4d9c9;
    border-radius: 10px;
    padding: 12px;
    margin: 8px 0;
    background: #fff;
  }
  .reader-item small {
    color: #68747d;
  }
  @media (max-width: 540px) {
    .reader-panel {
      inset: 0;
      width: 100vw;
      height: 100dvh;
      border-radius: 0;
    }
  }

  /* Original article HTML: preserve table/list semantics inside Lit Shadow DOM. */
  .article-original-html {
    font-size: 13px;
    line-height: 1.7;
    color: #26343e;
    overflow-wrap: anywhere;
  }
  .article-original-html h1,
  .article-original-html h2,
  .article-original-html h3,
  .article-original-html h4 {
    color: #233445;
    line-height: 1.4;
    margin: 18px 0 9px;
  }
  .article-original-html :is(ul, ol) {
    display: block;
    padding-inline-start: 26px;
    margin: 10px 0 15px;
  }
  .article-original-html ul { list-style: disc outside; }
  .article-original-html ol { list-style: decimal outside; }
  .article-original-html li { display: list-item; margin: 4px 0; }
  .article-original-html p { margin: 9px 0; white-space: normal; }
  .article-original-html a,
  .article-original-html :is(.api, .dictionary, .linksuggest, .lamp-trigger) {
    color: #2364a3;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .article-original-html :is(.api, .dictionary, .linksuggest, .lamp-trigger):focus-visible {
    outline: 3px solid #af8954;
  }
  .article-original-html table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    margin: 14px 0;
    overflow-wrap: anywhere;
  }
  .article-original-html :is(th,td) {
    border: 1px solid #d9e0e5;
    padding: 9px 11px;
    vertical-align: top;
    text-align: start;
  }
  .article-original-html th {
    background: #eaf1f7;
    font-weight: 700;
  }
  .article-original-html tr:nth-child(even) td { background: #f8fafc; }
  .article-original-html img {
    display: inline-block;
    margin: 8px auto;
    max-width: 100%;
    max-height: 430px;
    object-fit: contain;
    height: auto;
    border-radius: 7px;
    cursor: zoom-in;
  }
  .article-original-html :is(td, th) img { max-width: min(100%, 300px); }
  .article-original-html figure { margin: 15px 0; }
  .article-original-html figcaption {
    color: #5e7280;
    font-size: 11px;
    text-align: center;
  }
  .article-original-html blockquote {
    border-inline-start: 3px solid #b88a32;
    background: #fff8eb;
    margin: 15px 0;
    padding: 10px 14px;
  }
  .article-original-html .lamp-content { display: none; }
  .article-original-html .santo-amboss-card {
    display: block;
    background: #fff;
    border: 1px solid #d9e5f0;
    border-radius: 11px;
    margin: 13px 0;
    overflow: hidden;
    box-shadow: 0 2px 8px rgb(38 69 100 / 5%);
  }
  .santo-amboss-card > summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 11px 15px;
    background: #edf4fa;
    color: #264764;
    cursor: pointer;
    font-weight: 700;
    list-style: none;
  }
  .santo-amboss-card > summary::-webkit-details-marker { display: none; }
  .santo-amboss-card > summary:after { content: "⌄"; }
  .santo-amboss-card:not([open]) > summary:after { content: "›"; }
  .santo-amboss-card > summary h2 {
    font: inherit;
    color: inherit;
    margin: 0;
  }
  .santo-amboss-card-body { padding: 13px 16px; }
  .article-original-html .reader-highlight {
    outline: 3px solid #c49032;
    background-color: #fff2cc;
    border-radius: 6px;
    scroll-margin-top: 30px;
  }
  .reader-popover {
    position: absolute;
    z-index: 3;
    bottom: 14px;
    left: 14px;
    right: 14px;
    max-height: 42%;
    overflow: auto;
    border-radius: 12px;
    border: 1px solid #e1d3bc;
    background: #fffdf8;
    box-shadow: 0 11px 44px rgb(0 0 0 / 25%);
    padding: 18px;
  }
  .reader-popover > strong { display: block; padding-inline-end: 32px; margin-bottom: 9px; }
  .reader-lightbox {
    position: absolute;
    z-index: 4;
    inset: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    background: rgb(9 16 22 / 94%);
    color: white;
    padding: 55px 20px 25px;
    gap: 12px;
  }
  .reader-lightbox img {
    max-width: 100%;
    max-height: 85%;
    object-fit: contain;
  }
  .reader-lightbox span { max-width: 90%; font-size: 12px; text-align: center; }
  .lightbox-close {
    position: absolute;
    top: 10px;
    right: 12px;
    width: 44px;
    height: 44px;
    font-size: 25px;
    color: white;
    border: 1px solid rgb(255 255 255 / 35%);
    background: #293341;
    border-radius: 10px;
  }
  @media (max-width: 540px) {
    .reader-body { padding: 14px 15px 60px; }
    .reader-popover { left: 7px; right: 7px; bottom: 7px; max-height: 60%; }
  }
`;
