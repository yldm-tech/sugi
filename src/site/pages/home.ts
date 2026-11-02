import { MAX_FILE_BYTES } from "../../limits";
import { brand } from "../../config";
import { esc } from "../i18n";
import { Ctx, homeTitle, Page, siteDescription, tr } from "../layout";
import { ICONS } from "../og-images";
import { mascotStage } from "../svg";

const MiB = 1024 * 1024;

export function homePage(ctx: Ctx): Page {
  const t = tr(ctx);
  const b = brand(ctx.env);
  const strip = (o: string) => esc(o.replace(/^https?:\/\//, ""));
  const filesHost = strip(ctx.env.FILES_ORIGIN);
  const tmpHost = strip(ctx.env.TMP_ORIGIN);
  const maxMb = MAX_FILE_BYTES / MiB;
  const main = `<section class="hero">
<span class="deco d1" aria-hidden="true">✦</span><span class="deco d2" aria-hidden="true">♡</span><span class="deco d3" aria-hidden="true">✿</span><span class="deco d4" aria-hidden="true">✦</span>
<h1>${t("把图图交给仓仓吧～", "Hand your pics to the hamster~")}</h1>
<div class="tagrow"><span class="tag">kawaii-sugi file host</span><span class="tagnote">${t("可爱过头的图床", "the cutest image host")}</span></div>
<p class="facts">${t(`匿名 · 免费 · 不用注册也能传 · 单个文件最大 ${maxMb}MB`, `Anonymous · free · no sign-up · up to ${maxMb} MB per file`)}</p>
</section>

<section class="upload">
<div class="dz-wrap">
${mascotStage(t("今天屯点什么呢？", "What shall we stash today?"), t("戳戳仓仓", "Poke the hamster"))}
<div class="dropzone" id="dropzone" role="button" tabindex="0" aria-label="${t("选择要上传的图片或视频", "Choose images or videos to upload")}">
<div class="inner">
<div class="dz-title" id="dz-title">${t("把图片和视频拖到这里", "Drop images and videos here")}</div>
<div class="dz-hint"><span>${t("也可以", "or press")}</span><span class="kbd" id="paste-key">Ctrl + V</span><span>${t("直接粘贴截图哦", "to paste a screenshot")}</span></div>
<div class="dz-btn">✿ ${t("选择文件", "Choose files")} ✿</div>
</div>
</div>
<input type="file" id="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,image/avif,video/mp4,video/webm" hidden>
</div>
${ctx.gated ? `<p class="gate" id="gate">${t("暂未开放匿名上传：服务还在内测，目前只接受带令牌的上传。", "Anonymous uploads are not open yet: the service is in a closed test and only accepts uploads with a token.")}</p>` : ""}
<div class="opts">
<div class="expiry">
<span class="optlabel">${t("要保存多久呢", "Keep it for")}</span>
<div class="seg" id="expiry" role="radiogroup" aria-label="${t("保存时间", "Retention")}">
<button type="button" data-exp="perm" class="on" role="radio" aria-checked="true">${t("永久", "Forever")}</button>
<button type="button" data-exp="1h" role="radio" aria-checked="false">${t("1小时", "1 hour")}</button>
<button type="button" data-exp="12h" role="radio" aria-checked="false">${t("12小时", "12 hours")}</button>
<button type="button" data-exp="72h" role="radio" aria-checked="false">${t("3天", "3 days")}</button>
</div>
</div>
<div class="checks">
<label class="check"><input type="checkbox" id="opt-copy" checked><span>${t("传完自动复制", "Copy link when done")}</span></label>
<label class="check" title="${t("上传前在浏览器里抹掉照片里的 GPS 和相机信息（JPEG、PNG、WebP）", "Strip GPS and camera data in your browser before uploading (JPEG, PNG, WebP)")}"><input type="checkbox" id="opt-exif" checked><span>${t("抹掉照片位置信息", "Strip photo location")}</span></label>
<label class="check" title="${t("链接用可爱的短词，比如 mochi-fluffy-42.png。更好记，但也更容易被猜到", "Links made of cute words such as mochi-fluffy-42.png: easier to remember, but also easier to guess")}"><input type="checkbox" id="opt-cute" checked><span>${t("可爱链接名", "Cute link names")}</span></label>
<label class="check"><input type="checkbox" id="opt-sound"><span>${t("传完啾一声", "Chirp when done")}</span></label>
</div>
</div>
<form class="urlform" id="urlform">
<span class="ico" aria-hidden="true">🔗</span>
<input name="url" type="url" inputmode="url" autocomplete="off" placeholder="${t("或者贴一个图片链接，仓仓帮你搬过来", "Or paste an image link and the hamster will fetch it")}" aria-label="${t("图片或视频链接", "Image or video link")}">
<button type="submit">${t("搬过来", "Fetch")}</button>
</form>
<p class="small agree">${t('上传的文件都是公开的。上传即表示同意 <a href="/terms" data-nav>使用条款</a> 和 <a href="/privacy" data-nav>隐私政策</a>。', 'Uploads are public. By uploading you agree to the <a href="/terms" data-nav>terms</a> and the <a href="/privacy" data-nav>privacy policy</a>.')}</p>
</section>

<section class="stack" id="results" hidden>
<div class="results-head">
<h2><span>${t("仓仓收到啦", "Stashed")} <span class="heart">♡</span></span><span class="progress-text" id="progress-text"></span></h2>
<div class="row-actions">
<button type="button" class="mini" id="album-session" hidden>${t("打包成一个链接", "Make one link for all")}</button>
<button type="button" class="mini" id="copy-all">${t("复制全部", "Copy all")}</button>
<button type="button" class="mini bare" id="clear-done">${t("清空列表", "Clear list")}</button>
</div>
</div>
<div class="fmtrow"><span>${t("复制成", "Copy as")}</span><div class="seg" data-fmt-seg></div></div>
<div class="stack" id="results-list"></div>
</section>

<section class="features">
<div class="card feature"><div class="ic" aria-hidden="true">✿</div><div class="t">${ctx.flags.accounts ? t("登不登录都行", "Account optional") : t("不用注册", "No sign-up")}</div><div class="d">${ctx.flags.accounts ? t("打开就能传。想换设备也不丢，再登录就好。", "Just open and upload. Log in later to keep your files across devices.") : t("打开就能传。记录存在这个浏览器里，可以导出备份。", "Just open and upload. Your history stays in this browser and can be exported.")}</div></div>
<div class="card feature"><div class="ic" aria-hidden="true">✦</div><div class="t">${t("永久或临时", "Forever or for a while")}</div><div class="d">${t("默认永久保存，也能选 1 小时到 3 天，到期自动消失。", "Kept forever by default, or pick 1 hour to 3 days and it disappears on its own.")}</div></div>
<div class="card feature"><div class="ic" aria-hidden="true">♡</div><div class="t">${t("要乖乖的哦", "Be nice")}</div><div class="d">${t(`禁止违法内容，详见 <a href="/terms" data-nav>使用条款</a>。`, `No illegal content. See the <a href="/terms" data-nav>terms</a>.`)}</div></div>
</section>

<section class="terminal-card">
<div class="txt">
<div class="t">${ctx.flags.cli ? t("在终端里、让 AI 帮你传", "From the terminal, or by AI") : t("在终端里传", "From the terminal")}</div>
<div class="d">${
    ctx.flags.cli
      ? t("sugi 有 HTTP API、命令行工具和 MCP 服务。在 Claude、Cursor 里说一句「帮我把这张图传到 sugi」，仓仓就会把链接交回来。", "sugi has an HTTP API, a command-line tool and an MCP server. Tell Claude or Cursor “upload this picture to sugi” and the hamster hands back the link.")
      : t("sugi 有 HTTP API，curl 一行就能传，返回的就是直链。", "sugi has an HTTP API: one curl command uploads a file and prints its direct link.")
  }</div>
<a class="go" href="/dev" data-nav>${t("看看怎么用 →", "See how →")}</a>
</div>
<div class="term" aria-label="${t("示例", "Example")}">
<div class="dots"><i></i><i></i><i></i></div>
${
  ctx.flags.cli
    ? `<div class="cmdl"><span class="ps">$ </span>sugi up cat.png</div>
<div class="out">✿ ${filesHost}/k3x9qa2m.png${t("（已复制）", " (copied)")}</div>
<div class="cmdl mt6"><span class="ps">$ </span>sugi up -e 1h secret.jpg</div>
<div class="out">✿ ${tmpHost}/8fj2mz7q.jpg · ${t("1 小时后消失", "gone in 1 hour")}</div>`
    : `<div class="cmdl"><span class="ps">$ </span>curl -F file=@cat.png ${esc(ctx.env.MAIN_ORIGIN)}/api/upload</div>
<div class="out">✿ ${esc(ctx.env.FILES_ORIGIN)}/k3x9qa2m.png</div>
<div class="cmdl mt6"><span class="ps">$ </span>curl -F file=@secret.jpg -F expire=1h ${esc(ctx.env.MAIN_ORIGIN)}/api/upload</div>
<div class="out">✿ ${esc(ctx.env.TMP_ORIGIN)}/8fj2mz7q.jpg · ${t("1 小时后消失", "gone in 1 hour")}</div>`
}
</div>
</section>`;
  const origin = ctx.env.MAIN_ORIGIN;
  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: b.siteName,
      url: `${origin}/`,
      inLanguage: ["zh-CN", "en"],
      description: siteDescription(ctx),
      ...(b.operator ? { publisher: { "@id": `${origin}/#organization` } } : {}),
    },
    ...(b.operator
      ? [
          {
            "@context": "https://schema.org",
            "@type": "Organization",
            "@id": `${origin}/#organization`,
            name: b.operator,
            url: `${origin}/`,
            logo: `${origin}${ICONS.png512}`,
            ...(b.contactEmail ? { email: b.contactEmail } : {}),
          },
        ]
      : []),
  ];
  return { id: "home", title: homeTitle(ctx), main, jsonLd };
}
