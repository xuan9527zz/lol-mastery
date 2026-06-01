# LoL Mastery Tracker + aramgg ARAM Augments

这是一个可以上传到 GitHub Pages 的静态网页。

功能：
- 记录英雄联盟英雄 7级 / 10级成就
- 本地保存记录
- 导入 / 导出记录
- 点击英雄后显示 aramgg 当前快照中的前 20 个海克斯推荐

## 上传 GitHub Pages

1. 新建 GitHub repository
2. 上传本文件夹所有内容
3. 进入 `Settings -> Pages`
4. Source 选择 `Deploy from a branch`
5. Branch 选择 `main / root`
6. 保存

## 抓取 aramgg 数据

不用在本地安装 Node。上传后：

1. 打开 GitHub 仓库
2. 点 `Actions`
3. 选择 `Scrape aramgg augments once`
4. 点 `Run workflow`
5. 等它跑完并自动提交 `data/aramgg-augments.json`

之后打开 GitHub Pages 网页，点某个英雄的「查看前20海克斯推荐」即可。

## 本地运行爬虫（可选）

如果你愿意在电脑装 Node.js，也可以：

```bash
npm install
npm run scrape
```

## 注意

这个项目用于个人快照与个人使用。aramgg 页面或结构改变时，爬虫可能需要修改。
