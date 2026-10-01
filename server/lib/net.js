'use strict';

/**
 * 局域网访问信息（手机连同一个 Wi-Fi 时用）。
 *
 * 说明：Windows 上常见的坑是「网卡拿到了 169.254.x.x」——那是没拿到 DHCP 的
 * 自动私有地址，看起来像 IP 但根本连不通，所以这里直接排除掉。
 * 另外虚拟网卡（VMware / VirtualBox / Hyper-V / WSL）会在列表里混进来一堆
 * 不可达的地址，所以给出一个优先级：家庭/办公内网网段 + 无线网卡排前面。
 */

const os = require('os');
const fs = require('fs');

/** Tailscale 在 Windows 上的命令行位置（可用环境变量覆盖，方便非默认安装路径）。 */
const TAILSCALE_EXE = process.env.TAILSCALE_EXE || 'C:\\Program Files\\Tailscale\\tailscale.exe';

const virtualNicPattern = /virtual|vmware|vbox|hyper-v|vethernet|wsl|docker|loopback|bluetooth|tap|tun|zerotier|radmin|npcap/i;

/**
 * Tailscale 必须单独识别，不能和普通虚拟网卡一起埋到列表最后。
 * 普通虚拟网卡（VMware / WSL）是「从手机根本连不通」；
 * 而 Tailscale 的 100.64.0.0/10 地址恰恰相反 —— 手机装上 Tailscale
 * 登录同一个账号后，不管在 4G 还是别家 Wi-Fi 都能连上这台电脑。
 */
const tailscalePattern = /tailscale/i;
const CGNAT_RANGE = /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./;

/**
 * 单条网卡地址归类。抽成纯函数是为了能被自检直接验证：
 * 名字带 tailscale、或地址落在 100.64.0.0/10（CGNAT）的，都算 Tailscale。
 */
function classify(ifaceName, ip) {
  const isTailscale = tailscalePattern.test(ifaceName) || CGNAT_RANGE.test(ip);
  return {
    iface: ifaceName,
    ip: ip,
    virtual: !isTailscale && virtualNicPattern.test(ifaceName),
    kind: isTailscale ? 'tailscale' : 'lan'
  };
}

/**
 * 候选地址的排序权重（越小越优先）。导出是为了让自检能直接验证这条规则，
 * 而不是靠「这台机器上刚好有几种网卡」碰运气。
 */
function rankOf(x) {
  if (x.kind === 'tailscale') return 6;   // 排在真实局域网之后、其它虚拟网卡之前
  if (x.virtual) return 9;
  if (/wi-?fi|wlan|wireless|无线/i.test(x.iface)) return 0;
  if (x.ip.startsWith('192.168.')) return 1;
  if (x.ip.startsWith('10.')) return 2;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(x.ip)) return 3;
  return 4;
}

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((name) => {
    (ifaces[name] || []).forEach((info) => {
      const fam = info.family;
      if (fam !== 'IPv4' && fam !== 4) return;
      if (info.internal) return;
      const ip = String(info.address || '');
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) return;
      out.push(classify(name, ip));
    });
  });

  const rank = rankOf;
  out.sort((a, b) => rank(a) - rank(b) || a.iface.localeCompare(b.iface));
  return out;
}

/** 单机地址 -> 手机可直接打开的 URL。 */
function lanUrl(ip, port) {
  return 'http://' + ip + ':' + port + '/?app=1';
}

function lanUrls(port) {
  return lanAddresses().map((x) => ({
    iface: x.iface,
    ip: x.ip,
    virtual: x.virtual,
    kind: x.kind,
    url: lanUrl(x.ip, port)
  }));
}

/** 首选地址：无线网卡优先，其次真实的 192.168 / 10 网段。 */
function primaryUrl(port) {
  return lanUrls(port)[0] || null;
}

/**
 * 防火墙提示：Windows 默认会拦下别人发到本机 8787 的连接，
 * 手机连不上时多半是这个原因，所以把状态一并报出来，别让用户瞎猜。
 */
function firewallNote() {
  if (process.platform !== 'win32') return null;
  return '如果手机打不开，多半是 Windows 防火墙拦了入站连接：用管理员身份运行一次 desktop\\允许手机访问.ps1（或手动放行 TCP 8787）即可。';
}

/** 只取 Tailscale 给的那条地址（异地访问用）。 */
function tailscaleAddresses() {
  return lanAddresses().filter((x) => x.kind === 'tailscale');
}

/**
 * Tailscale 装没装。装了但没登录时网卡拿不到 100.x 地址，
 * 光看网卡列表会让人以为「装失败了」，所以单独报一下。
 */
function tailscaleInstalled() {
  if (process.platform !== 'win32') return false;
  try { return fs.existsSync(TAILSCALE_EXE); } catch (err) { return false; }
}

module.exports = {
  lanAddresses,
  lanUrl,
  lanUrls,
  primaryUrl,
  tailscaleAddresses,
  classify,
  rankOf,
  tailscaleInstalled,
  firewallNote,
  virtualNicPattern,
  tailscalePattern
};
