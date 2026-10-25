/* Valve equipment silhouettes; see ICON_SOURCES.md for provenance and rights. */
(() => {
  'use strict';
  const definitions = {
    ak47: ['ak47', 'AK-47'], aug: ['aug', 'AUG'], awp: ['awp', 'AWP'],
    bizon: ['bizon', 'PP-Bizon'], cz75a: ['cz75a', 'CZ75-Auto'],
    deagle: ['deagle', 'Desert Eagle'], elite: ['elite', 'Dual Berettas'],
    famas: ['famas', 'FAMAS'], fiveseven: ['fiveseven', 'Five-SeveN'],
    g3sg1: ['g3sg1', 'G3SG1'], galil: ['galilar', 'Galil AR'],
    glock: ['glock', 'Glock-18'], p2000: ['hkp2000', 'P2000'],
    m249: ['m249', 'M249'], m4a4: ['m4a1', 'M4A4'],
    m4a1s: ['m4a1_silencer', 'M4A1-S'], mac10: ['mac10', 'MAC-10'],
    mag7: ['mag7', 'MAG-7'], mp5sd: ['mp5sd', 'MP5-SD'],
    mp7: ['mp7', 'MP7'], mp9: ['mp9', 'MP9'], negev: ['negev', 'Negev'],
    nova: ['nova', 'Nova'], p250: ['p250', 'P250'], p90: ['p90', 'P90'],
    revolver: ['revolver', 'R8 Revolver'], sawedoff: ['sawedoff', 'Sawed-Off'],
    scar20: ['scar20', 'SCAR-20'], sg553: ['sg556', 'SG 553'],
    ssg08: ['ssg08', 'SSG 08'], taser: ['taser', 'Zeus x27'],
    tec9: ['tec9', 'Tec-9'], ump45: ['ump45', 'UMP-45'],
    usps: ['usp_silencer', 'USP-S'], xm1014: ['xm1014', 'XM1014'],
    knife: ['knife', '匕首'], c4: ['c4', 'C4 炸弹'],
    smoke: ['smokegrenade', '烟雾弹'], flash: ['flashbang', '闪光弹'],
    he: ['hegrenade', '高爆手雷'], molotov: ['molotov', '燃烧瓶'],
    incendiary: ['incgrenade', '燃烧弹'], decoy: ['decoy', '诱饵弹'],
    armor: ['kevlar', '防弹衣'], helmet: ['helmet', '头盔'],
    armorhelmet: ['armor_helmet', '防弹衣与头盔'], kit: ['defuser', '拆包钳'],
    headshot: ['headshot', '爆头'], penetrate: ['penetrate', '穿透击杀'],
    noscope: ['noscope', '未开镜击杀'], smokekill: ['smoke_kill', '穿烟击杀'],
    blindkill: ['blind_kill', '致盲中击杀'], unknown: ['unknown', '未知装备'],
  };
  const aliases = {
    desertEagle: 'deagle', dualberettas: 'elite', dualies: 'elite',
    cz75auto: 'cz75a', cz75: 'cz75a', cz: 'cz75a',
    ppbizon: 'bizon', galilar: 'galil', glock18: 'glock',
    hkp2000: 'p2000', m4a1: 'm4a1s', m4a1silencer: 'm4a1s',
    m4a1silenceroff: 'm4a1s', mp5: 'mp5sd', r8revolver: 'revolver',
    sg556: 'sg553', scout: 'ssg08', zeus: 'taser', zeusx27: 'taser',
    usp: 'usps', uspsilencer: 'usps', uspsilenceroff: 'usps',
    bomb: 'c4', plantedc4: 'c4',
    smokegrenade: 'smoke', smokegrenadeprojectile: 'smoke',
    flashbang: 'flash', flashgrenade: 'flash',
    hegrenade: 'he', highexplosive: 'he', highexplosivegrenade: 'he',
    molotovgrenade: 'molotov', molotovprojectile: 'molotov',
    incgrenade: 'incendiary', incendiarygrenade: 'incendiary', inferno: 'incendiary',
    decoygrenade: 'decoy', decoyprojectile: 'decoy',
    kevlar: 'armor', kevlarvest: 'armor', vest: 'armor',
    kevlarhelmet: 'armorhelmet', vesthelm: 'armorhelmet',
    defuser: 'kit', defusekit: 'kit', wallbang: 'penetrate',
    throughsmoke: 'smokekill', attackerblind: 'blindkill',
    烟雾弹: 'smoke', 闪光弹: 'flash', 高爆手雷: 'he', 手雷: 'he',
    燃烧瓶: 'molotov', 燃烧弹: 'incendiary', 诱饵弹: 'decoy',
  };
  // demoinfocs calls the silenced rifle "M4A1"; the raw engine class
  // weapon_m4a1 instead means M4A4. Keep these two inputs unambiguous.
  const normalize = name => String(name ?? '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  const aliasLookup = Object.fromEntries(Object.entries(aliases).map(([a, b]) => [normalize(a), b]));
  function key(name) {
    const raw = String(name ?? '').trim().toLowerCase();
    if (raw === 'weapon_m4a1') return 'm4a4';
    const nameKey = normalize(raw.replace(/^weapon_/, ''));
    if (Object.hasOwn(definitions, nameKey)) return nameKey;
    if (Object.hasOwn(aliasLookup, nameKey)) return aliasLookup[nameKey];
    if (nameKey.includes('knife') || nameKey.includes('bayonet')) return 'knife';
    return 'unknown';
  }
  function label(name) {
    const iconKey = key(name);
    return iconKey === 'unknown' && name && name !== 'UNKNOWN' ? String(name) : definitions[iconKey][1];
  }
  const images = new Map();
  const failures = [];
  const ready = Promise.all(Object.entries(definitions).map(([iconKey, [file]]) => new Promise(resolve => {
    const image = new Image();
    image.onload = () => { images.set(iconKey, image); resolve(); };
    image.onerror = () => { failures.push(iconKey); resolve(); };
    image.src = `/icons/${file}.svg`;
  }))).then(() => {
    window.dispatchEvent(new Event('replay-icons-ready'));
    return { loaded: images.size, failed: failures.slice() };
  });

  // Cache a high-resolution tinted raster per icon and color. This avoids SVG
  // parsing, canvas allocation, or compositing work on each playback frame.
  const tintCache = new Map();
  const tintURLCache = new Map();
  const white = value => !value || ['white', '#fff', '#ffffff'].includes(String(value).toLowerCase());
  function tinted(iconKey, color) {
    const image = images.get(iconKey) || images.get('unknown');
    if (!image || white(color)) return image;
    const cacheKey = `${iconKey}:${color}`;
    if (tintCache.has(cacheKey)) return tintCache.get(cacheKey);
    const canvas = document.createElement('canvas');
    const factor = 256 / Math.max(image.naturalWidth, image.naturalHeight, 1);
    canvas.width = Math.max(1, Math.round(image.naturalWidth * factor));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * factor));
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = 'source-in';
    context.fillStyle = color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (tintCache.size >= 128) tintCache.delete(tintCache.keys().next().value);
    tintCache.set(cacheKey, canvas);
    return canvas;
  }
  function element(name, options = {}) {
    const iconKey = key(name);
    const image = document.createElement('img');
    image.className = `equipment-icon${options.className ? ` ${options.className}` : ''}`;
    image.alt = options.decorative ? '' : label(name);
    image.title = options.title ?? label(name);
    image.draggable = false;
    image.decoding = 'async';
    image.style.objectFit = 'contain';
    image.style.flexShrink = '0';
    image.width = options.width ?? (isUtility(iconKey) ? 16 : 42);
    image.height = options.height ?? 20;
    image.src = `/icons/${definitions[iconKey][0]}.svg`;
    if (options.decorative) image.setAttribute('aria-hidden', 'true');
    image.addEventListener('error', () => {
      if (!image.src.endsWith('/icons/unknown.svg')) image.src = '/icons/unknown.svg';
    }, { once: true });
    if (!white(options.color)) {
      ready.then(() => {
        const cacheKey = `${iconKey}:${options.color}`;
        if (!tintURLCache.has(cacheKey)) {
          const canvas = tinted(iconKey, options.color);
          if (!canvas?.toDataURL) return;
          if (tintURLCache.size >= 128) tintURLCache.delete(tintURLCache.keys().next().value);
          tintURLCache.set(cacheKey, canvas.toDataURL('image/png'));
        }
        image.src = tintURLCache.get(cacheKey);
      });
    }
    return image;
  }
  function isUtility(name) {
    return ['smoke', 'flash', 'he', 'molotov', 'incendiary', 'decoy', 'c4'].includes(key(name));
  }
  function draw(context, name, x, y, width, height, options = {}) {
    const image = tinted(key(name), options.color);
    if (!image || !(width > 0 && height > 0)) return false;
    const nativeWidth = image.naturalWidth || image.width;
    const nativeHeight = image.naturalHeight || image.height;
    const scale = Math.min(width / nativeWidth, height / nativeHeight);
    context.save();
    context.globalAlpha *= options.alpha ?? 1;
    context.translate(x, y);
    if (options.flip) context.scale(-1, 1);
    context.drawImage(image, -nativeWidth * scale / 2, -nativeHeight * scale / 2, nativeWidth * scale, nativeHeight * scale);
    context.restore();
    return true;
  }
  window.ReplayIcons = Object.freeze({ key, label, element, draw, isUtility, ready });
})();
