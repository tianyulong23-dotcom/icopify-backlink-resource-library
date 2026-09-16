# 外链资源库

本项目是 ICOPIFY 项目 `39023` 的本地外链资源库，包含抓取数据、联系方式补充结果、查询 API 和可视化前端。

## 数据概况

- 主资源：49,742 条去重网站记录
- 原始抓取：2,047 页
- 后续导入：298 条去重资源
- 联系方式任务：298 个网站，86 个网站找到至少一种联系方式
- 价格字段：仅作为参考价格，不代表实时成交价格

数据快照位于 `data/icopify-39023/`：

- `publishers.sqlite`：前端和 API 使用的主资源数据库
- `contacts.sqlite`：联系方式及抓取状态
- `publishers.csv`：便于表格工具读取的导出文件
- `publishers.raw.jsonl`：原始抓取行数据
- `pages/`：按页保存的抓取结果
- `summary.json`：数据汇总和导入记录

## 本地运行

需要 Node.js 22 或更高版本。

```powershell
npm ci
npm start
```

然后访问：

```text
http://127.0.0.1:4188/
```

## 测试

```powershell
npm test
```

## 常用命令

```powershell
# 抓取 ICOPIFY 资源
npm run scrape

# 抓取公开联系方式
npm run crawl:contacts

# 导入其他任务中的资源并去重
npm run import:thread-resources
```

## 数据说明

- 仓库不包含浏览器登录资料、Cookie、密码、令牌或环境变量。
- 联系方式来自网站公开页面；抓取程序遵守 `robots.txt`，并记录阻止、错误和未找到状态。
- 数据是本地快照，流量、DR、DA、语言和参考价格可能随时间变化。
- 使用数据时应遵守目标网站条款、隐私规则和适用法律。
