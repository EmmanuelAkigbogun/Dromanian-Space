export function getYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    if (host.startsWith('m.')) host = host.slice(2);
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const path = parsed.pathname;
      if (path === '/watch' || path.startsWith('/watch')) {
        const v = parsed.searchParams.get('v');
        if (v) return v;
      }
      if (path.startsWith('/shorts/')) {
        const id = path.split('/')[2];
        if (id) return id;
      }
      if (path.startsWith('/embed/')) {
        const id = path.split('/')[2];
        if (id) return id;
      }
    }
    if (host === 'youtu.be') {
      const id = parsed.pathname.slice(1);
      if (id) return id;
    }
  } catch {
    // ignore malformed URLs
  }
  return null;
}

export interface VideoEmbedInfo {
  kind: 'youtube' | 'vimeo' | 'dailymotion' | 'twitch';
  embedUrl: string;
}

export function getVideoEmbedInfo(url: string): VideoEmbedInfo | null {
  try {
    const parsed = new URL(url);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    if (host.startsWith('m.')) host = host.slice(2);

    const videoId = getYouTubeVideoId(url);
    if (videoId) {
      return { kind: 'youtube', embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}` };
    }

    if (host === 'vimeo.com') {
      const id = parsed.pathname.split('/')[1];
      if (id && /^\d+$/.test(id)) {
        return { kind: 'vimeo', embedUrl: `https://player.vimeo.com/video/${id}` };
      }
    }

    if (host === 'dailymotion.com') {
      const id = parsed.pathname.startsWith('/video/') ? parsed.pathname.split('/')[2] : null;
      if (id) return { kind: 'dailymotion', embedUrl: `https://www.dailymotion.com/embed/video/${id}` };
    }
    if (host === 'dai.ly') {
      const id = parsed.pathname.slice(1);
      if (id) return { kind: 'dailymotion', embedUrl: `https://www.dailymotion.com/embed/video/${id}` };
    }

    if (host === 'twitch.tv') {
      const channel = parsed.pathname.split('/')[1];
      if (channel) {
        const parent = typeof window !== 'undefined' ? window.location.hostname : '';
        return {
          kind: 'twitch',
          embedUrl: `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=${encodeURIComponent(parent)}&autoplay=false`,
        };
      }
    }
  } catch {
    // ignore malformed URLs
  }
  return null;
}

export function getEmbeddableUrl(url: string): string {
  const info = getVideoEmbedInfo(url);
  if (info) return info.embedUrl;
  return url;
}

export function hostnameOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

export function getYouTubeThumbnail(url: string): string | null {
  const videoId = getYouTubeVideoId(url);
  if (!videoId) return null;
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}
