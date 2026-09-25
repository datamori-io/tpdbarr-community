# Where things live

**Generated — do not hand-edit.** Re-run after moving anything:

```
docker run --rm -v "$PWD:/app" -w /app tpdbarr-portal:latest node docs/make-map.mjs
```

Written 2026-09-25 from 65 files.

## Addresses

Every `#/` the front end answers, and what draws it. The library half is
served by `shelf.js` and claimed before `app.js` sees the address.

| Address | Draws it | Where |
|---|---|---|
| `#/binge/redgifs` | `gifs.show` | public/app.js:84 |
| `#/binge/reddit` | `social.show` | public/app.js:85 |
| `#/binge/plugin` | `showBingePlugin` | public/app.js:86 |
| `#/binge` | `reel.show` | public/app.js:87 |
| `#/import/video` | `showAcquire` | public/app.js:111 |
| `#/import/images` | `showImages` | public/app.js:112 |
| `#/catalogue/groups` | `showGroupBuilder` | public/app.js:121 |
| `#/catalogue/match` | `showMatch` | public/app.js:122 |
| `#/catalogue/wildcard` | `showWildcard` | public/app.js:123 |
| `#/catalogue/markers` | `showMarkerBuilder` | public/app.js:124 |
| `#/catalogue` | `showCatalogue` | public/app.js:125 |
| `#/import/tracked` | `showTracked` | public/app.js:126 |
| `#/import/integrations` | `showIntegrations` | public/app.js:127 |
| `#/import/console` | `showHome` | public/app.js:128 |
| `#/import/performers` | `showPerformers` | public/app.js:129 |
| `#/import` | `showOverview` | public/app.js:130 |
| `#/thanks` | `showThanks` | public/app.js:131 |
| `#/parameters/catchup` | `showCatchUp` | public/app.js:162 |
| `#/parameters/feed` | `showFeed` | public/app.js:163 |
| `#/parameters/galleries` | `showGallerySettings` | public/app.js:164 |
| `#/parameters/catalog` | `showCatalogSettings` | public/app.js:165 |
| `#/parameters/sending` | `showSending` | public/app.js:166 |
| `#/parameters/stash` | `showStash` | public/app.js:167 |
| `#/parameters` | `showConnections` | public/app.js:168 |
| `^#\/site\/(\d+)$` | `showSite` | public/app.js:62 |
| `'^#/scene/' + UUID + '$'` | `showScene` | public/app.js:65 |
| `'^#/performer/' + UUID + '$'` | `showPerformer` | public/app.js:68 |
| `'^#/movie/' + UUID + '$'` | `showMovie` | public/app.js:71 |
| `^#\/search\/(.+)$` | `showSearch` | public/app.js:76 |
| `#/stats` | `showStats` | public/shelf.js:26 |
| `#/library/categories` | `showCategories` | public/shelf.js:55 |
| `#/library` | `showOverview` | public/shelf.js:75 |
| `^#\/library\/scene\/(\d+)$` | `showScene` | public/shelf.js:28 |
| `^#\/library\/movie\/([0-9a-f]{12})$` | `showMovie` | public/shelf.js:33 |
| `^#\/library\/group\/(\d+)$` | `showGroup` | public/shelf.js:37 |
| `^#\/library\/performer\/(\d+)$` | `showPerformer` | public/shelf.js:40 |
| `^#\/library\/studio\/(\d+)$` | `showStudio` | public/shelf.js:43 |
| `^#\/library\/gallery\/(\d+)$` | `showGallery` | public/shelf.js:46 |
| `^#\/library\/list\/([a-z]+)$` | `showList` | public/shelf.js:49 |
| `^#\/library\/category\/([a-z0-9-]+)(?:\?(.*))?$` | `showCategory` | public/shelf.js:53 |
| `^#\/library\/(scenes|performers|studios|galleries)(?:\?(.*))?$` | `—` | public/shelf.js:59 |
| `^#\/library\/movies(?:\?(.*))?$` | `showMovies` | public/shelf.js:70 |
| `^#\/library\/stage\/([a-z]+)$` | `showStage` | public/shelf.js:72 |

## API

|  | Path | Where |
|---|---|---|
| `GET` | `\/api\/state` | src/server.mjs:129 |
| `GET` | `\/api\/home` | src/server.mjs:181 |
| `GET` | `\/api\/options` | src/server.mjs:191 |
| `POST` | `\/api\/config` | src/server.mjs:205 |
| `POST` | `\/api\/tilescale` | src/server.mjs:220 |
| `GET` | `\/api\/sites` | src/server.mjs:236 |
| `GET` | `\/api\/sites\/(\d+)` | src/server.mjs:241 |
| `GET` | `\/api\/scenes\/([0-9a-fA-F-]{36})` | src/server.mjs:247 |
| `GET` | `\/api\/performers\/([0-9a-fA-F-]{36})` | src/server.mjs:249 |
| `GET` | `\/api\/movies` | src/server.mjs:252 |
| `GET` | `\/api\/movies\/([0-9a-fA-F-]{36})` | src/server.mjs:259 |
| `GET` | `\/api\/creators` | src/server.mjs:261 |
| `GET` | `\/api\/sites\/(\d+)\/art` | src/server.mjs:264 |
| `POST` | `\/api\/add` | src/server.mjs:286 |
| `GET` | `\/api\/queue` | src/server.mjs:305 |
| `GET` | `\/api\/stashdb\/search` | src/server.mjs:329 |
| `GET` | `\/api\/stashdb\/scenes\/([0-9a-fA-F-]{36})` | src/server.mjs:340 |
| `GET` | `\/api\/stashdb\/bridge\/([0-9a-fA-F-]{36})` | src/server.mjs:353 |
| `GET` | `\/api\/import\/overview` | src/server.mjs:374 |
| `GET` | `\/api\/import\/integrations` | src/server.mjs:382 |
| `GET` | `\/api\/import\/backups` | src/server.mjs:385 |
| `POST` | `\/api\/import\/backups` | src/server.mjs:388 |
| `GET` | `\/api\/import\/images\/places` | src/server.mjs:391 |
| `GET` | `\/api\/import\/match\/sources` | src/server.mjs:402 |
| `GET` | `\/api\/import\/match\/sites` | src/server.mjs:407 |
| `GET` | `\/api\/import\/match` | src/server.mjs:410 |
| `GET` | `\/api\/catalogue\/overview` | src/server.mjs:436 |
| `GET` | `\/api\/catalogue\/scan` | src/server.mjs:440 |
| `POST` | `\/api\/catalogue\/scan` | src/server.mjs:443 |
| `GET` | `\/api\/catalogue\/scan\/(\d+)` | src/server.mjs:446 |
| `GET` | `\/api\/catalogue\/generate` | src/server.mjs:453 |
| `POST` | `\/api\/catalogue\/generate` | src/server.mjs:456 |
| `GET` | `\/api\/catalogue\/generate\/(\d+)` | src/server.mjs:459 |
| `GET` | `\/api\/manage\/scan` | src/server.mjs:463 |
| `POST` | `\/api\/manage\/scan` | src/server.mjs:466 |
| `GET` | `\/api\/manage\/scan\/(\d+)` | src/server.mjs:469 |
| `GET` | `\/api\/manage\/duplicates` | src/server.mjs:472 |
| `GET` | `\/api\/manage\/chores` | src/server.mjs:475 |
| `POST` | `\/api\/manage\/chores\/stop` | src/server.mjs:477 |
| `GET` | `\/api\/manage\/reshelve` | src/server.mjs:479 |
| `POST` | `\/api\/manage\/reshelve` | src/server.mjs:482 |
| `POST` | `\/api\/manage\/copies\/keep-better` | src/server.mjs:485 |
| `POST` | `\/api\/manage\/nfo\/(missing|all)` | src/server.mjs:488 |
| `POST` | `\/api\/manage\/thumbs\/(missing|all)` | src/server.mjs:491 |
| `GET` | `\/api\/import\/match\/phash` | src/server.mjs:495 |
| `POST` | `\/api\/import\/match\/phash` | src/server.mjs:498 |
| `GET` | `\/api\/import\/match\/phash\/(\d+)` | src/server.mjs:501 |
| `POST` | `\/api\/scenes\/(\d+)\/generate` | src/server.mjs:505 |
| `GET` | `\/api\/scenes\/(\d+)\/generate\/(\d+)` | src/server.mjs:508 |
| `GET` | `\/api\/import\/match\/(\d+)` | src/server.mjs:511 |
| `POST` | `\/api\/import\/match\/(\d+)` | src/server.mjs:517 |
| `POST` | `\/api\/import\/match\/(\d+)\/page` | src/server.mjs:536 |
| `POST` | `\/api\/import\/match\/(\d+)\/rename\/plan` | src/server.mjs:540 |
| `GET` | `\/api\/import\/wildcard\/sources` | src/server.mjs:554 |
| `GET` | `\/api\/import\/wildcard\/find` | src/server.mjs:557 |
| `GET` | `\/api\/import\/wildcard\/names` | src/server.mjs:564 |
| `POST` | `\/api\/import\/wildcard\/names` | src/server.mjs:572 |
| `GET` | `\/api\/import\/wildcard\/scene\/(\d+)` | src/server.mjs:579 |
| `GET` | `\/api\/(?:catalogue|import\/wildcard)\/frames\/(\d+)` | src/server.mjs:584 |
| `POST` | `\/api\/(?:catalogue|import\/wildcard)\/frames\/(\d+)` | src/server.mjs:587 |
| `POST` | `\/api\/import\/wildcard\/urls` | src/server.mjs:590 |
| `POST` | `\/api\/import\/wildcard\/ask` | src/server.mjs:593 |
| `POST` | `\/api\/import\/wildcard\/scene\/(\d+)` | src/server.mjs:596 |
| `POST` | `\/api\/import\/wildcard\/scene\/(\d+)\/rename\/plan` | src/server.mjs:602 |
| `POST` | `\/api\/import\/match\/(\d+)\/aside` | src/server.mjs:607 |
| `GET` | `\/api\/import\/match\/(\d+)\/rename` | src/server.mjs:611 |
| `POST` | `\/api\/import\/match\/(\d+)\/rename` | src/server.mjs:614 |
| `GET` | `\/api\/import\/tags` | src/server.mjs:617 |
| `POST` | `\/api\/import\/tags` | src/server.mjs:620 |
| `GET` | `\/api\/import\/groups` | src/server.mjs:632 |
| `POST` | `\/api\/import\/groups\/scan` | src/server.mjs:635 |
| `POST` | `\/api\/import\/groups\/titles` | src/server.mjs:641 |
| `GET` | `\/api\/import\/groups\/proposals` | src/server.mjs:644 |
| `POST` | `\/api\/import\/groups\/([^/]+)\/approve` | src/server.mjs:648 |
| `POST` | `\/api\/import\/groups\/([^/]+)\/decline` | src/server.mjs:653 |
| `POST` | `\/api\/import\/groups\/([^/]+)\/reconsider` | src/server.mjs:656 |
| `POST` | `\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)` | src/server.mjs:660 |
| `DELETE` | `\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)` | src/server.mjs:663 |
| `GET` | `\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)\/find` | src/server.mjs:667 |
| `POST` | `\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)\/find` | src/server.mjs:671 |
| `GET` | `\/api\/import\/markers` | src/server.mjs:679 |
| `GET` | `\/api\/import\/markers\/queue` | src/server.mjs:687 |
| `GET` | `\/api\/import\/markers\/all` | src/server.mjs:691 |
| `GET` | `\/api\/import\/markers\/tags` | src/server.mjs:701 |
| `GET` | `\/api\/import\/markers\/tags\/search` | src/server.mjs:704 |
| `GET` | `\/api\/import\/markers\/scene\/(\d+)` | src/server.mjs:707 |
| `POST` | `\/api\/import\/markers\/scene\/(\d+)` | src/server.mjs:710 |
| `POST` | `\/api\/import\/markers\/marker\/(\d+)` | src/server.mjs:720 |
| `DELETE` | `\/api\/import\/markers\/marker\/(\d+)` | src/server.mjs:731 |
| `GET` | `\/api\/import\/markers\/scene\/(\d+)\/sources` | src/server.mjs:735 |
| `GET` | `\/api\/import\/markers\/scene\/(\d+)\/strip` | src/server.mjs:739 |
| `POST` | `\/api\/import\/markers\/scene\/(\d+)\/strip` | src/server.mjs:741 |
| `DELETE` | `\/api\/import\/markers\/scene\/(\d+)\/strip` | src/server.mjs:754 |
| `GET` | `\/api\/import\/images\/galleries` | src/server.mjs:759 |
| `GET` | `\/api\/import\/images\/performers` | src/server.mjs:765 |
| `GET` | `\/api\/acquire\/search` | src/server.mjs:770 |
| `GET` | `\/api\/acquire\/lookup` | src/server.mjs:774 |
| `GET` | `\/api\/acquire\/chips` | src/server.mjs:781 |
| `GET` | `\/api\/acquire\/wildcard` | src/server.mjs:791 |
| `GET` | `\/api\/acquire\/prowlarr` | src/server.mjs:797 |
| `GET` | `\/api\/acquire\/monitored` | src/server.mjs:809 |
| `GET` | `\/api\/acquire\/manualdrop` | src/server.mjs:818 |
| `POST` | `\/api\/acquire\/manualdrop` | src/server.mjs:819 |
| `POST` | `\/api\/acquire\/prowlarr\/grab` | src/server.mjs:823 |
| `GET` | `\/api\/acquire\/rules` | src/server.mjs:839 |
| `POST` | `\/api\/acquire\/rules` | src/server.mjs:842 |
| `GET` | `\/api\/acquire\/tracked` | src/server.mjs:845 |
| `POST` | `\/api\/acquire\/tracked` | src/server.mjs:850 |
| `DELETE` | `\/api\/acquire\/tracked\/(performer|studio|tag)\/([0-9a-fA-F-]{36})` | src/server.mjs:858 |
| `GET` | `\/api\/acquire\/release` | src/server.mjs:869 |
| `POST` | `\/api\/acquire\/release` | src/server.mjs:871 |
| `POST` | `\/api\/acquire\/release\/now` | src/server.mjs:875 |
| `GET` | `\/api\/acquire\/tracked\/scenes` | src/server.mjs:878 |
| `POST` | `\/api\/acquire\/tracked\/scenes` | src/server.mjs:886 |
| `POST` | `\/api\/acquire\/tracked\/scenes\/backfill` | src/server.mjs:890 |
| `POST` | `\/api\/acquire\/ignored` | src/server.mjs:894 |
| `POST` | `\/api\/acquire\/ignored\/batch` | src/server.mjs:901 |
| `POST` | `\/api\/acquire\/skiprest` | src/server.mjs:905 |
| `GET` | `\/api\/acquire\/skiprest` | src/server.mjs:911 |
| `DELETE` | `\/api\/acquire\/ignored\/([0-9a-fA-F-]{36})` | src/server.mjs:913 |
| `DELETE` | `\/api\/acquire\/tracked\/scenes\/([0-9a-fA-F-]{36})` | src/server.mjs:918 |
| `GET` | `\/api\/library\/rails` | src/server.mjs:935 |
| `GET` | `\/api\/library\/feeds` | src/server.mjs:939 |
| `GET` | `\/api\/library\/overview` | src/server.mjs:943 |
| `GET` | `\/api\/library\/films` | src/server.mjs:946 |
| `GET` | `\/api\/library\/films\/lookup` | src/server.mjs:949 |
| `POST` | `\/api\/library\/films\/(group|film)\/(\d+)\/scrape` | src/server.mjs:955 |
| `POST` | `\/api\/library\/films\/(group|film)\/(\d+)\/apply` | src/server.mjs:962 |
| `POST` | `\/api\/library\/films\/(group|film)\/(\d+)\/delete` | src/server.mjs:966 |
| `GET` | `\/api\/library\/performers` | src/server.mjs:969 |
| `GET` | `\/api\/library\/studios` | src/server.mjs:971 |
| `GET` | `\/api\/library\/identify\/movies` | src/server.mjs:978 |
| `POST` | `\/api\/library\/identify\/covers` | src/server.mjs:982 |
| `POST` | `\/api\/library\/identify\/movies` | src/server.mjs:989 |
| `GET` | `\/api\/library\/groups\/urls` | src/server.mjs:992 |
| `POST` | `\/api\/library\/groups\/(\d+)\/scrape` | src/server.mjs:1001 |
| `POST` | `\/api\/library\/groups\/(\d+)\/apply` | src/server.mjs:1008 |
| `POST` | `\/api\/library\/groups\/(\d+)\/url` | src/server.mjs:1014 |
| `GET` | `\/api\/library\/in-flight` | src/server.mjs:1021 |
| `GET` | `\/api\/library\/stage\/([a-z]+)` | src/server.mjs:1024 |
| `GET` | `\/api\/tidy` | src/server.mjs:1034 |
| `POST` | `\/api\/tidy\/unmonitor` | src/server.mjs:1037 |
| `POST` | `\/api\/tidy\/remove` | src/server.mjs:1039 |
| `GET` | `\/api\/library\/gaps` | src/server.mjs:1045 |
| `GET` | `\/api\/library\/shelf` | src/server.mjs:1065 |
| `GET` | `\/api\/library\/list\/([a-z]+)` | src/server.mjs:1067 |
| `GET` | `\/api\/library\/categories` | src/server.mjs:1074 |
| `GET` | `\/api\/library\/categories\/terms` | src/server.mjs:1075 |
| `POST` | `\/api\/library\/categories\/preview` | src/server.mjs:1076 |
| `POST` | `\/api\/library\/categories` | src/server.mjs:1080 |
| `GET` | `\/api\/library\/categories\/([a-z0-9-]+)` | src/server.mjs:1085 |
| `POST` | `\/api\/library\/categories\/([a-z0-9-]+)` | src/server.mjs:1090 |
| `DELETE` | `\/api\/library\/categories\/([a-z0-9-]+)` | src/server.mjs:1092 |
| `POST` | `\/api\/library\/categories\/([a-z0-9-]+)\/refresh` | src/server.mjs:1096 |
| `DELETE` | `\/api\/library\/categories\/([a-z0-9-]+)\/art` | src/server.mjs:1099 |
| `POST` | `\/api\/library\/categories\/([a-z0-9-]+)\/scenes` | src/server.mjs:1102 |
| `POST` | `\/api\/library\/categories\/([a-z0-9-]+)\/order` | src/server.mjs:1104 |
| `GET` | `\/api\/library\/scenes\/(\d+)\/categories` | src/server.mjs:1108 |
| `GET` | `\/api\/library\/reel` | src/server.mjs:1112 |
| `GET` | `\/api\/library\/reel\/settings` | src/server.mjs:1179 |
| `POST` | `\/api\/library\/reel\/settings` | src/server.mjs:1181 |
| `GET` | `\/api\/library\/reel\/tags` | src/server.mjs:1193 |
| `GET` | `\/api\/reddit` | src/server.mjs:1196 |
| `GET` | `\/api\/markerclips` | src/server.mjs:1200 |
| `POST` | `\/api\/markerclips\/generate` | src/server.mjs:1202 |
| `GET` | `\/api\/redgifs` | src/server.mjs:1208 |
| `POST` | `\/api\/redgifs\/refresh` | src/server.mjs:1210 |
| `POST` | `\/api\/redgifs\/follow` | src/server.mjs:1215 |
| `POST` | `\/api\/redgifs\/unfollow` | src/server.mjs:1223 |
| `POST` | `\/api\/redgifs\/tags` | src/server.mjs:1228 |
| `POST` | `\/api\/redgifs\/tags\/remove` | src/server.mjs:1234 |
| `POST` | `\/api\/reddit\/follow` | src/server.mjs:1239 |
| `POST` | `\/api\/reddit\/unfollow` | src/server.mjs:1247 |
| `POST` | `\/api\/reddit\/refresh` | src/server.mjs:1252 |
| `GET` | `\/api\/library\/scenes\/(\d+)` | src/server.mjs:1258 |
| `GET` | `\/api\/library\/performers\/(\d+)` | src/server.mjs:1264 |
| `GET` | `\/api\/library\/performers\/(\d+)\/iafd` | src/server.mjs:1271 |
| `POST` | `\/api\/library\/performers\/(\d+)\/iafd` | src/server.mjs:1275 |
| `GET` | `\/api\/library\/studios\/(\d+)` | src/server.mjs:1279 |
| `GET` | `\/api\/library\/studios\/(\d+)\/facts` | src/server.mjs:1289 |
| `POST` | `\/api\/library\/studios\/(\d+)\/facts` | src/server.mjs:1292 |
| `GET` | `\/api\/library\/groups\/(\d+)` | src/server.mjs:1295 |
| `GET` | `\/api\/library\/galleries` | src/server.mjs:1304 |
| `GET` | `\/api\/library\/galleries\/gaps` | src/server.mjs:1315 |
| `GET` | `\/api\/library\/galleries\/(\d+)` | src/server.mjs:1318 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/organized` | src/server.mjs:1321 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/rating` | src/server.mjs:1324 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/title` | src/server.mjs:1328 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/cover` | src/server.mjs:1331 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/focus` | src/server.mjs:1334 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/ties` | src/server.mjs:1343 |
| `GET` | `\/api\/library\/lookup` | src/server.mjs:1351 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/rescan` | src/server.mjs:1363 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/images\/delete` | src/server.mjs:1374 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/delete` | src/server.mjs:1378 |
| `GET` | `\/api\/galleries\/setup` | src/server.mjs:1388 |
| `POST` | `\/api\/galleries\/setup` | src/server.mjs:1391 |
| `POST` | `\/api\/galleries\/find` | src/server.mjs:1393 |
| `POST` | `\/api\/galleries\/build` | src/server.mjs:1407 |
| `GET` | `\/api\/galleries\/jobs\/(\d+)` | src/server.mjs:1440 |
| `GET` | `\/api\/library\/search` | src/server.mjs:1446 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/activity` | src/server.mjs:1453 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/play` | src/server.mjs:1459 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/organized` | src/server.mjs:1467 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/rating` | src/server.mjs:1491 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/o` | src/server.mjs:1494 |
| `GET` | `\/api\/library\/scenes\/(\d+)\/downscale` | src/server.mjs:1501 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/downscale` | src/server.mjs:1504 |
| `GET` | `\/api\/library\/scenes\/(\d+)\/resolution` | src/server.mjs:1508 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/resolution` | src/server.mjs:1510 |
| `GET` | `\/api\/library\/catchup` | src/server.mjs:1520 |
| `POST` | `\/api\/library\/catchup` | src/server.mjs:1525 |
| `GET` | `\/api\/library\/downscale` | src/server.mjs:1529 |
| `GET` | `\/api\/library\/scenes\/(\d+)\/removal` | src/server.mjs:1531 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/delete` | src/server.mjs:1534 |
| `GET` | `\/api\/moviefiles` | src/server.mjs:1548 |
| `GET` | `\/api\/moviefiles\/([0-9a-f]{12})` | src/server.mjs:1551 |
| `POST` | `\/api\/moviefiles\/([0-9a-f]{12})\/activity` | src/server.mjs:1558 |
| `POST` | `\/api\/moviefiles\/([0-9a-f]{12})\/play` | src/server.mjs:1564 |
| `POST` | `\/api\/moviefiles\/([0-9a-f]{12})\/forget` | src/server.mjs:1566 |
| `GET` | `\/api\/moviefiles\/([0-9a-f]{12})\/candidates` | src/server.mjs:1569 |
| `POST` | `\/api\/moviefiles\/([0-9a-f]{12})\/metadata` | src/server.mjs:1575 |
| `GET` | `\/api\/whisparr3\/scenes\/([0-9a-fA-F-]{36})` | src/server.mjs:1598 |
| `POST` | `\/api\/whisparr3\/scenes\/([0-9a-fA-F-]{36})` | src/server.mjs:1601 |
| `POST` | `\/api\/whisparr3\/scenes\/([0-9a-fA-F-]{36})\/again` | src/server.mjs:1614 |
| `GET` | `\/api\/whisparr3\/queue` | src/server.mjs:1622 |

## Inside what is still large

`shelf.js` was 5,813 lines and is now a router over `public/library/`. These
two are what is left of that shape; the only structure they have is their banner
comments, so jump to a line rather than searching the file.



## Line counts

| File | Lines |
|---|---|
| src/server.mjs | 2321 |
| public/markerbuilder.js | 1411 |
| public/library/categories.js | 1164 |
| public/library/galleries.js | 1127 |
| public/import/search.js | 964 |
| public/css/140-import.css | 956 |
| public/css/150-markers.css | 903 |
| public/library/movies.js | 842 |
| public/library/scene.js | 826 |
| public/library/overview.js | 711 |
| public/player.js | 680 |
| public/css/120-binge.css | 646 |
| public/css/010-chrome.css | 499 |
| public/css/090-overview.css | 491 |
| public/library/tiles.js | 478 |
| public/import/tracked.js | 478 |
| public/import/cards.js | 472 |
| public/library/shelves.js | 459 |
| public/library/core.js | 432 |
| public/library/group.js | 420 |
| public/css/110-search.css | 412 |
| public/css/100-galleries.css | 377 |
| public/reel/controls.js | 358 |
| public/css/050-scene.css | 347 |
| public/markermanage.js | 339 |
| public/markerfetch.js | 333 |
| public/css/160-categories.css | 315 |
| public/css/030-rails.css | 309 |
| public/css/080-films.css | 307 |
| public/reel/slides.js | 303 |
| public/library/tracked.js | 300 |
| public/import/site.js | 270 |
| public/css/040-player.css | 269 |
| public/app.js | 263 |
| public/import/movies.js | 257 |
| public/catalogue.js | 256 |
| public/import/images.js | 247 |
| public/import/console.js | 240 |
| public/import/core.js | 238 |
| public/css/020-cards.css | 215 |
| public/reel.js | 202 |
| public/markertag.js | 193 |
| public/library/studio.js | 192 |
| public/library/performer.js | 188 |
| public/import/rules.js | 186 |
| public/import/monitored.js | 173 |
| public/import/integrations.js | 165 |
| public/library/facts.js | 159 |
| public/import/performers.js | 149 |
| public/reel/media.js | 129 |
| public/reel/gestures.js | 122 |
| public/import/thanks.js | 118 |
| public/library/picture.js | 117 |
| public/import/send.js | 115 |
| public/import/overview.js | 108 |
| public/css/060-creators.css | 99 |
| public/reel/config.js | 96 |
| public/css/000-base.css | 95 |
| public/reel/core.js | 92 |
| public/css/070-facets.css | 91 |
| public/css/130-narrow.css | 90 |
| public/import/scene.js | 85 |
| public/shelf.js | 78 |
| public/reel/keeps.js | 47 |
| public/css/170-picture.css | 14 |
