import "./uiPreview.css";
import { formatCount, formatDuration } from "../ui/formatter";
import { iconSvg, type IconName } from "../ui/icons";
import { createTokenStyleText } from "../ui/tokens";

const app = document.querySelector<HTMLElement>("#preview-app");
if (!app) throw new Error("缺少 UI 预览根节点");

const tokenStyle = document.createElement("style");
tokenStyle.textContent = createTokenStyleText(":root");
document.head.append(tokenStyle);

function icon(name: IconName, size = 14): string {
  return iconSvg(name, { size });
}

const values = {
  play: formatCount(833_500),
  like: formatCount(112_200),
  comment: formatCount(626),
  collect: formatCount(8_524),
  share: formatCount(15_600),
  duration: formatDuration(18),
  engagement: "16.4%",
  date: "2026/06/28",
};

function heading(index: number, title: string, note: string): string {
  return `<header class="sample-heading"><span>${String(index).padStart(2, "0")}</span><div><h2>${title}</h2><p>${note}</p></div><em>UI 示例数据</em></header>`;
}

function detailRows(): string {
  const rows: Array<[IconName, string, string]> = [
    ["play", "播放", values.play],
    ["heart", "点赞", values.like],
    ["comment", "评论", values.comment],
    ["bookmark", "收藏", values.collect],
    ["share", "分享", values.share],
    ["clock", "时长", values.duration],
    ["data", "互动率", values.engagement],
  ];
  return rows.map(([name, label, value]) => `<div class="detail-row"><i>${icon(name)}</i><span>${label}</span><strong>${value}</strong></div>`).join("");
}

function gridCard(options: {
  title: string;
  play: string;
  duration?: string;
  date?: string;
  engagement?: string;
  collect?: string;
  like?: string;
  comment?: string;
  share?: string;
  photo?: boolean;
  ad?: boolean;
  product?: boolean;
  nativePlay?: boolean;
}): string {
  const chips = [
    options.ad ? `<span class="chip flag">${icon("data", 12)}广告</span>` : "",
    options.product && !options.ad ? `<span class="chip flag">${icon("bookmark", 12)}带货</span>` : "",
    !options.nativePlay ? `<span class="chip">${icon("play", 12)}${options.play}</span>` : "",
  ].join("");
  return `<article class="grid-card">
    <div class="card-art ${options.photo ? "photo" : "video"}">
      <div class="zone top-left">${chips}</div>
      <div class="zone top-right">${options.engagement ? `<span class="chip" title="互动率 =（点赞+评论+收藏+分享）/播放">${icon("data", 12)}${options.engagement}</span>` : ""}${options.duration ? `<span class="chip">${icon("clock", 12)}${options.duration}</span>` : ""}${options.date ? `<span class="chip">${icon("calendar", 12)}${options.date}</span>` : ""}</div>
      <div class="zone bottom-left">${options.collect ? `<span class="chip">${icon("bookmark", 12)}${options.collect}</span>` : ""}</div>
      <div class="card-quick-actions"><button title="下载无水印视频">${icon("video", 16)}</button><button title="提取音频">${icon("music", 16)}</button></div>
      ${options.nativePlay ? `<span class="native-play">${icon("play", 12)}${options.play}</span>` : ""}
      <span class="art-label">${options.photo ? "图文卡片" : "视频封面"}</span>
    </div>
    <footer class="card-footer"><div>${options.share ? `<span>${icon("share", 12)}${options.share}</span>` : ""}${options.comment ? `<span>${icon("comment", 12)}${options.comment}</span>` : ""}${options.like ? `<span>${icon("heart", 12)}${options.like}</span>` : ""}</div><p>${options.title}</p></footer>
  </article>`;
}

function toolbar(): string {
  return `<section class="profile-toolbar">
    <span class="count"><b>18</b> 已识别 <b>12</b> 筛选后</span>
    <button>${icon("refresh")}刷新</button>
    <select aria-label="真实排序">
      <option>默认顺序</option><option>最新发布</option><option>最早发布</option>
      <option>播放量最高</option><option>点赞量最高</option><option>评论量最高</option>
      <option>收藏量最高</option><option>分享量最高</option><option>互动率最高</option>
    </select>
    <label class="batch-scope"><input type="checkbox" checked />批量全选 <b>12</b></label>
    <button class="batch-download" id="preview-batch" title="批量下载已选视频" aria-label="批量下载已选视频">${icon("export")}</button>
    <span class="spacer"></span>
    <button id="preview-filter">${icon("filter")}筛选</button>
    <button id="preview-auto" aria-pressed="false">${icon("chevronDown")}<span>自动滚动</span></button>
    <button>${icon("export")}导出 CSV</button>
    <output class="batch-progress" id="preview-batch-progress" hidden><span><strong>0%</strong></span></output>
    <aside id="preview-filter-panel" hidden>
      <label class="wide">关键词<input placeholder="描述、作者账号或帖子 ID" /></label>
      <label>发布时间<div><input type="date" /><i>—</i><input type="date" /></div></label>
      <label>视频时长范围<div><input placeholder="最小秒数" /><i>—</i><input placeholder="最大秒数" /></div></label>
      <label>播放量范围<div><input placeholder="最小" /><i>—</i><input placeholder="最大" /></div></label>
      <label>点赞量范围<div><input placeholder="最小" /><i>—</i><input placeholder="最大" /></div></label>
      <label>评论量范围<div><input placeholder="最小" /><i>—</i><input placeholder="最大" /></div></label>
      <label>收藏量范围<div><input placeholder="最小" /><i>—</i><input placeholder="最大" /></div></label>
      <label>分享量范围<div><input placeholder="最小" /><i>—</i><input placeholder="最大" /></div></label>
      <label>互动率范围<div><input placeholder="最小 %" /><i>—</i><input placeholder="最大 %" /></div></label>
      <footer><button>重置</button><button class="accent">应用筛选</button></footer>
    </aside>
  </section>`;
}

function sidepanel(): string {
  return `<aside class="sidepanel">
    <header><div><small>字幕生成 · 自动翻译</small><h3>视频字幕</h3></div><span>本地服务正常</span></header>
    <section class="subtitle-preview"><header><b>字幕和翻译</b><em>原语言：英语</em></header>
      <div class="subtitle-controls"><select aria-label="翻译语言"><option>简体中文</option></select><label>双语 <input type="checkbox" checked></label></div>
      <p class="subtitle-state">已生成并翻译 · Google 在线</p>
      ${[
        ["00:03–00:05", "Why did you do that? I need to get to work.", "你为什么要这么做？我得去上班了。"],
        ["00:05–00:06", "I can't be late.", "我不能迟到。"],
        ["00:06–00:09", "Maybe you should find a ride that keeps up with traffic.", "或许你应该找一辆跟得上车流的车。"],
        ["00:09–00:11", "You did that on purpose?", "你是故意的吗？"],
      ].map(([time, original, translated]) => `<article><time>${time}</time><div><p>${original}</p><p>${translated}</p></div></article>`).join("")}
    </section>
  </aside>`;
}

app.innerHTML = `
  <header class="preview-header"><div><p>阶段 1.4 · 产品级 UI/UX</p><h1>TikTok 达人助手视觉验收</h1></div><strong>仅本地预览</strong></header>
  <div class="notice">${icon("info", 16)}<span>全部为 UI 示例数据：不访问 TikTok、不调用后端、不写入数据库。未知字段在页面增强层直接隐藏，不用 0 或“--”占位。</span></div>

  <section class="sample single-sample">${heading(1, "主页推荐 · 轻量快捷操作", "圆形播放量贴合原生操作列；下载、音频、字幕不再依赖常驻大侧栏")}
    <div class="single-stage"><div class="phone-video"><span>当前媒体</span><div class="native-actions"><b>${icon("heart")}112.2K</b><b>${icon("comment")}626</b><b>${icon("bookmark")}8.5K</b><b>${icon("share")}15.6K</b></div><section id="preview-details" hidden><header><b>视频数据</b><button id="preview-close" aria-label="收起">${icon("close")}</button></header><div>${detailRows()}</div></section><button class="date-badge" id="preview-date">${icon("calendar", 13)}${values.date}</button></div>
      <div class="single-overlay"><nav class="quick-rail"><button title="下载无水印视频">${icon("video",18)}</button><button title="提取音频">${icon("music",18)}</button><button title="生成字幕">${icon("subtitle",18)}</button></nav><div class="play-trigger" id="preview-expand">${icon("play",18)}<strong>${values.play}</strong></div></div>
    </div>
  </section>

  <section class="sample">${heading(2, "博主主页 · 数据下移", "原生播放量保持无遮挡；分享、评论、点赞与文案移至卡片下方，悬停只露出下载")}
    <div class="card-row">
      ${gridCard({ title: "普通视频 · 原生已有播放", play: "3.1M", duration: "0:42", date: "2026/06/14", engagement: "3.7%", collect: "2.7K", like: "8.2K", comment: "113", share: "2K", nativePlay: true })}
      ${gridCard({ title: "图文帖子 · 无时长则不占位", play: "131.8K", date: "2026/06/11", engagement: "18.9%", collect: "5K", like: "17K", comment: "122", share: "2.3K", photo: true, product: true })}
      ${gridCard({ title: "明确广告/推广标记", play: "296.1K", duration: "0:18", date: "2026/07/14", collect: "1.9K", like: "19.3K", comment: "220", share: "1.3K", ad: true })}
    </div>
  </section>

  <section class="sample toolbar-sample">${heading(3, "达人主页 · 页内批量下载", "选择保存位置后只显示圆形进度；不打开侧栏或额外任务弹窗")}${toolbar()}</section>

  <section class="preview-two">
    <article class="sample translation-sample">${heading(4, "评论区 · 两枚图标", "翻译工具只在评论区出现；自动翻译再次点击即可停止")}
      <div class="translation-demo"><header><button class="comment-tool active" title="开始或停止自动翻译" aria-label="开始或停止自动翻译">${icon("translate",17)}</button><button class="comment-tool" title="下载全部评论" aria-label="下载全部评论">${icon("document",17)}</button></header><article><p>Mist & shade, walking cloud.</p><button>译为中文</button><blockquote>薄雾与阴影，如同行云。</blockquote></article><article><p>How much is it?</p><button>译为中文</button><blockquote>这个多少钱？</blockquote></article></div>
    </article>
    <article class="sample">${heading(5, "按需侧栏 · 只承载字幕", "下载不再打开侧栏；字幕工作区保留语言、双语开关和逐句时间轴")}
      <div class="sidepanel-wrap">${sidepanel()}</div>
    </article>
  </section>
`;

function setDetailExpanded(expanded: boolean): void {
  const details = document.querySelector<HTMLElement>("#preview-details");
  const trigger = document.querySelector<HTMLButtonElement>("#preview-expand");
  if (details) details.hidden = !expanded;
  trigger?.setAttribute("aria-expanded", String(expanded));
}

document.querySelector("#preview-expand")?.addEventListener("click", () => {
  const details = document.querySelector<HTMLElement>("#preview-details");
  setDetailExpanded(Boolean(details?.hidden));
});
document.querySelector("#preview-date")?.addEventListener("click", () => setDetailExpanded(true));
document.querySelector("#preview-close")?.addEventListener("click", () => setDetailExpanded(false));
document.querySelector<HTMLButtonElement>("#preview-filter")?.addEventListener("click", () => {
  const panel = document.querySelector<HTMLElement>("#preview-filter-panel");
  if (panel) panel.hidden = !panel.hidden;
});
document.querySelector<HTMLButtonElement>("#preview-auto")?.addEventListener("click", (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  const running = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(running));
  const label = button.querySelector("span");
  if (label) label.textContent = running ? "停止滚动" : "自动滚动";
});

document.querySelector<HTMLButtonElement>("#preview-batch")?.addEventListener("click", () => {
  const progress = document.querySelector<HTMLOutputElement>("#preview-batch-progress");
  const value = progress?.querySelector<HTMLElement>("strong");
  const ring = progress?.querySelector<HTMLElement>("span");
  if (!progress || !value || !ring) return;
  progress.hidden = false;
  let percent = 0;
  const timer = window.setInterval(() => {
    percent = Math.min(100, percent + 13);
    value.textContent = `${percent}%`;
    ring.style.setProperty("--preview-progress", `${percent * 3.6}deg`);
    if (percent >= 100) window.clearInterval(timer);
  }, 120);
});
