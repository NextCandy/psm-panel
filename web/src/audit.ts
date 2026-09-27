// The audit log's actions, as the pages name them.
export const ACTIONS: Record<string, string> = {
  login: '登录', 'login.failed': '登录失败', logout: '退出登录',
  'server.add': '添加服务器', 'server.update': '修改服务器', 'server.delete': '移除服务器', 'server.forget': '从面板移除服务器',
  'server.leave': '卸载服务器', 'server.left': '服务器已卸载', 'server.join': '服务器接入', 'server.diagnose': '诊断服务器',
  'server.upgrade-agent': '升级 agent / 更新 PSM', 'server.sni-find': '查找伪装目标', 'server.new-command': '重新生成安装命令',
  'node.add': '新建节点', 'node.update': '修改节点', 'node.delete': '删除节点', 'traffic.reset': '重置流量',
  'relay.add': '新建中转', 'relay.update': '修改中转', 'relay.delete': '删除中转',
  'subscription.add': '新建订阅', 'subscription.update': '修改订阅', 'subscription.reset': '重置订阅地址', 'subscription.delete': '删除订阅',
  'settings.update': '修改设置', 'settings.reveal-key': '查看加密密钥', 'settings.reveal-key.failed': '查看密钥失败',
  'settings.forget-key': '删除数据库里的密钥',
  'template.add': '新建订阅模板', 'template.update': '修改订阅模板', 'template.delete': '删除订阅模板',
}
export const actionLabel = (a: string) => ACTIONS[a] ?? a
