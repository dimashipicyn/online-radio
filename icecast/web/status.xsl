<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform" version="1.0">
<xsl:output method="html" omit-xml-declaration="yes" indent="no"/>
<xsl:template match="/icestats">
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta http-equiv="refresh" content="15"/>
<title>Статус эфира</title>
<style>
  :root { --bg:#0d0f12; --card:#161a20; --line:#242a33; --txt:#e6e9ee; --dim:#8a94a3; --acc:#ff5c39; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--txt); font:15px/1.5 system-ui,-apple-system,sans-serif; }
  .wrap { max-width:720px; margin:0 auto; padding:24px 16px 60px; }
  header { display:flex; align-items:center; gap:14px; margin:14px 0 6px; flex-wrap:wrap; }
  h1 { font-size:26px; letter-spacing:.5px; }
  .live { background:var(--acc); color:#fff; font-size:11px; font-weight:700; padding:3px 9px; border-radius:20px; letter-spacing:1px; }
  .live.off { background:#3a4149; }
  .sub { color:var(--dim); font-size:13px; margin-bottom:20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; margin-bottom:16px; }
  .mount { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--dim); margin-bottom:10px; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--acc); animation:pulse 1.6s infinite; }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.3; } }
  .np { font-size:19px; font-weight:600; min-height:26px; }
  .stats { display:flex; gap:12px; flex-wrap:wrap; margin:14px 0; }
  .stats div { background:#0f1216; border:1px solid var(--line); border-radius:8px; padding:8px 14px; min-width:110px; }
  .stats span { display:block; font-size:11px; color:var(--dim); text-transform:uppercase; letter-spacing:1px; }
  .stats b { font-size:18px; }
  .links { display:flex; gap:8px; flex-wrap:wrap; }
  a { color:var(--txt); background:#0f1216; border:1px solid var(--line); border-radius:8px;
      padding:7px 14px; text-decoration:none; font-size:13px; }
  a:hover { border-color:var(--acc); color:var(--acc); }
  a.main { background:var(--acc); border-color:var(--acc); color:#fff; font-weight:600; }
  a.main:hover { filter:brightness(1.1); color:#fff; }
  .empty { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; text-align:center; color:var(--dim); }
  footer { margin-top:18px; color:var(--dim); font-size:12px; display:flex; gap:14px; flex-wrap:wrap; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>📻 <xsl:choose>
      <xsl:when test="source[1]/server_name != ''"><xsl:value-of select="source[1]/server_name"/></xsl:when>
      <xsl:otherwise>Онлайн радио</xsl:otherwise>
    </xsl:choose></h1>
    <xsl:choose>
      <xsl:when test="count(source) > 0"><span class="live">В ЭФИРЕ</span></xsl:when>
      <xsl:otherwise><span class="live off">ОФФЛАЙН</span></xsl:otherwise>
    </xsl:choose>
  </header>
  <div class="sub">Слушателей сейчас: <b><xsl:value-of select="sum(source/listeners)"/></b> · страница обновляется каждые 15 с</div>

  <xsl:for-each select="source">
    <div class="card">
      <div class="mount"><span class="dot"></span><xsl:value-of select="@mount"/></div>
      <div class="np">
        <xsl:choose>
          <xsl:when test="title != ''"><xsl:value-of select="title"/></xsl:when>
          <xsl:otherwise>— тишина в эфире —</xsl:otherwise>
        </xsl:choose>
      </div>
      <div class="stats">
        <div><span>Слушателей</span><b><xsl:value-of select="listeners"/></b></div>
        <div><span>Пик</span><b><xsl:value-of select="listener_peak"/></b></div>
        <div><span>Битрейт</span><b>
          <xsl:choose>
            <xsl:when test="bitrate != ''"><xsl:value-of select="bitrate"/> kbps</xsl:when>
            <xsl:otherwise>—</xsl:otherwise>
          </xsl:choose></b></div>
      </div>
      <div class="links">
        <a class="main" href="{@mount}">▶ Слушать</a>
        <a href="{@mount}.m3u">Плейлист .m3u</a>
      </div>
    </div>
  </xsl:for-each>

  <xsl:if test="count(source) = 0">
    <div class="empty">Эфир не в сети. Загляните позже — или уже открывайте плеер: как только зазвучит, вы это узнаете первыми.</div>
  </xsl:if>

  <footer>
    <a id="uiLink" href="#">Веб-интерфейс станции</a>
    <a href="/admin/stats.xsl">Админка</a>
    <span class="muted">icecast2</span>
  </footer>
</div>
<script>
  document.getElementById('uiLink').href =
    window.location.protocol + '//' + window.location.hostname + ':3000';
</script>
</body>
</html>
</xsl:template>
</xsl:stylesheet>
