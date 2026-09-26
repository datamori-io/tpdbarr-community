# Where things live

**Generated — do not hand-edit.** Re-run after moving anything:

```
docker run --rm -v "$PWD:/app" -w /app tpdbarr-portal:latest node docs/make-map.mjs
```

Written 2026-09-26 from 65 files.

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
| `GET` | `\/api\/queue` | src/server.mjs:306 |
| `GET` | `\/api\/stashdb\/search` | src/server.mjs:330 |
| `GET` | `\/api\/stashdb\/scenes\/([0-9a-fA-F-]{36})` | src/server.mjs:341 |
| `GET` | `\/api\/stashdb\/bridge\/([0-9a-fA-F-]{36})` | src/server.mjs:354 |
| `GET` | `\/api\/import\/overview` | src/server.mjs:375 |
| `GET` | `\/api\/import\/integrations` | src/server.mjs:383 |
| `GET` | `\/api\/import\/backups` | src/server.mjs:386 |
| `POST` | `\/api\/import\/backups` | src/server.mjs:389 |
| `GET` | `\/api\/import\/images\/places` | src/server.mjs:392 |
| `GET` | `\/api\/import\/match\/sources` | src/server.mjs:403 |
| `GET` | `\/api\/import\/match\/sites` | src/server.mjs:408 |
| `GET` | `\/api\/import\/match` | src/server.mjs:411 |
| `GET` | `\/api\/catalogue\/overview` | src/server.mjs:437 |
| `GET` | `\/api\/catalogue\/scan` | src/server.mjs:441 |
| `POST` | `\/api\/catalogue\/scan` | src/server.mjs:444 |
| `GET` | `\/api\/catalogue\/scan\/(\d+)` | src/server.mjs:447 |
| `GET` | `\/api\/catalogue\/generate` | src/server.mjs:454 |
| `POST` | `\/api\/catalogue\/generate` | src/server.mjs:457 |
| `GET` | `\/api\/catalogue\/generate\/(\d+)` | src/server.mjs:460 |
| `GET` | `\/api\/manage\/scan` | src/server.mjs:464 |
| `POST` | `\/api\/manage\/scan` | src/server.mjs:467 |
| `GET` | `\/api\/manage\/scan\/(\d+)` | src/server.mjs:470 |
| `GET` | `\/api\/manage\/duplicates` | src/server.mjs:473 |
| `GET` | `\/api\/manage\/chores` | src/server.mjs:476 |
| `POST` | `\/api\/manage\/chores\/stop` | src/server.mjs:478 |
| `GET` | `\/api\/manage\/reshelve` | src/server.mjs:480 |
| `POST` | `\/api\/manage\/reshelve` | src/server.mjs:483 |
| `POST` | `\/api\/manage\/copies\/keep-better` | src/server.mjs:486 |
| `POST` | `\/api\/manage\/nfo\/(missing|all)` | src/server.mjs:489 |
| `POST` | `\/api\/manage\/thumbs\/(missing|all)` | src/server.mjs:492 |
| `GET` | `\/api\/import\/match\/phash` | src/server.mjs:496 |
| `POST` | `\/api\/import\/match\/phash` | src/server.mjs:499 |
| `GET` | `\/api\/import\/match\/phash\/(\d+)` | src/server.mjs:502 |
| `POST` | `\/api\/scenes\/(\d+)\/generate` | src/server.mjs:506 |
| `GET` | `\/api\/scenes\/(\d+)\/generate\/(\d+)` | src/server.mjs:509 |
| `GET` | `\/api\/import\/match\/(\d+)` | src/server.mjs:512 |
| `POST` | `\/api\/import\/match\/(\d+)` | src/server.mjs:518 |
| `POST` | `\/api\/import\/match\/(\d+)\/page` | src/server.mjs:537 |
| `POST` | `\/api\/import\/match\/(\d+)\/rename\/plan` | src/server.mjs:541 |
| `GET` | `\/api\/import\/wildcard\/sources` | src/server.mjs:555 |
| `GET` | `\/api\/import\/wildcard\/find` | src/server.mjs:558 |
| `GET` | `\/api\/import\/wildcard\/names` | src/server.mjs:565 |
| `POST` | `\/api\/import\/wildcard\/names` | src/server.mjs:573 |
| `GET` | `\/api\/import\/wildcard\/scene\/(\d+)` | src/server.mjs:580 |
| `GET` | `\/api\/(?:catalogue|import\/wildcard)\/frames\/(\d+)` | src/server.mjs:585 |
| `POST` | `\/api\/(?:catalogue|import\/wildcard)\/frames\/(\d+)` | src/server.mjs:588 |
| `POST` | `\/api\/import\/wildcard\/urls` | src/server.mjs:591 |
| `POST` | `\/api\/import\/wildcard\/ask` | src/server.mjs:594 |
| `POST` | `\/api\/import\/wildcard\/scene\/(\d+)` | src/server.mjs:597 |
| `POST` | `\/api\/import\/wildcard\/scene\/(\d+)\/rename\/plan` | src/server.mjs:603 |
| `POST` | `\/api\/import\/match\/(\d+)\/aside` | src/server.mjs:608 |
| `GET` | `\/api\/import\/match\/(\d+)\/rename` | src/server.mjs:612 |
| `POST` | `\/api\/import\/match\/(\d+)\/rename` | src/server.mjs:615 |
| `GET` | `\/api\/import\/tags` | src/server.mjs:618 |
| `POST` | `\/api\/import\/tags` | src/server.mjs:621 |
| `GET` | `\/api\/import\/groups` | src/server.mjs:633 |
| `POST` | `\/api\/import\/groups\/scan` | src/server.mjs:636 |
| `POST` | `\/api\/import\/groups\/titles` | src/server.mjs:642 |
| `GET` | `\/api\/import\/groups\/proposals` | src/server.mjs:645 |
| `POST` | `\/api\/import\/groups\/([^/]+)\/approve` | src/server.mjs:649 |
| `POST` | `\/api\/import\/groups\/([^/]+)\/decline` | src/server.mjs:654 |
| `POST` | `\/api\/import\/groups\/([^/]+)\/reconsider` | src/server.mjs:657 |
| `POST` | `\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)` | src/server.mjs:661 |
| `DELETE` | `\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)` | src/server.mjs:664 |
| `GET` | `\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)\/find` | src/server.mjs:668 |
| `POST` | `\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)\/find` | src/server.mjs:672 |
| `GET` | `\/api\/import\/markers` | src/server.mjs:680 |
| `GET` | `\/api\/import\/markers\/queue` | src/server.mjs:688 |
| `GET` | `\/api\/import\/markers\/all` | src/server.mjs:692 |
| `GET` | `\/api\/import\/markers\/tags` | src/server.mjs:702 |
| `GET` | `\/api\/import\/markers\/tags\/search` | src/server.mjs:705 |
| `GET` | `\/api\/import\/markers\/scene\/(\d+)` | src/server.mjs:708 |
| `POST` | `\/api\/import\/markers\/scene\/(\d+)` | src/server.mjs:711 |
| `POST` | `\/api\/import\/markers\/marker\/(\d+)` | src/server.mjs:721 |
| `DELETE` | `\/api\/import\/markers\/marker\/(\d+)` | src/server.mjs:732 |
| `GET` | `\/api\/import\/markers\/scene\/(\d+)\/sources` | src/server.mjs:736 |
| `GET` | `\/api\/import\/markers\/scene\/(\d+)\/strip` | src/server.mjs:740 |
| `POST` | `\/api\/import\/markers\/scene\/(\d+)\/strip` | src/server.mjs:742 |
| `DELETE` | `\/api\/import\/markers\/scene\/(\d+)\/strip` | src/server.mjs:755 |
| `GET` | `\/api\/import\/images\/galleries` | src/server.mjs:760 |
| `GET` | `\/api\/import\/images\/performers` | src/server.mjs:766 |
| `GET` | `\/api\/acquire\/search` | src/server.mjs:771 |
| `GET` | `\/api\/acquire\/lookup` | src/server.mjs:775 |
| `GET` | `\/api\/acquire\/chips` | src/server.mjs:782 |
| `GET` | `\/api\/acquire\/wildcard` | src/server.mjs:792 |
| `GET` | `\/api\/acquire\/prowlarr` | src/server.mjs:798 |
| `GET` | `\/api\/acquire\/monitored` | src/server.mjs:810 |
| `GET` | `\/api\/acquire\/manualdrop` | src/server.mjs:819 |
| `POST` | `\/api\/acquire\/manualdrop` | src/server.mjs:820 |
| `POST` | `\/api\/acquire\/prowlarr\/grab` | src/server.mjs:824 |
| `GET` | `\/api\/acquire\/rules` | src/server.mjs:840 |
| `POST` | `\/api\/acquire\/rules` | src/server.mjs:843 |
| `GET` | `\/api\/acquire\/tracked` | src/server.mjs:846 |
| `POST` | `\/api\/acquire\/tracked` | src/server.mjs:851 |
| `DELETE` | `\/api\/acquire\/tracked\/(performer|studio|tag)\/([0-9a-fA-F-]{36})` | src/server.mjs:859 |
| `GET` | `\/api\/acquire\/release` | src/server.mjs:870 |
| `POST` | `\/api\/acquire\/release` | src/server.mjs:872 |
| `POST` | `\/api\/acquire\/release\/now` | src/server.mjs:876 |
| `GET` | `\/api\/acquire\/tracked\/scenes` | src/server.mjs:879 |
| `POST` | `\/api\/acquire\/tracked\/scenes` | src/server.mjs:887 |
| `POST` | `\/api\/acquire\/tracked\/scenes\/backfill` | src/server.mjs:891 |
| `POST` | `\/api\/acquire\/ignored` | src/server.mjs:895 |
| `POST` | `\/api\/acquire\/ignored\/batch` | src/server.mjs:902 |
| `POST` | `\/api\/acquire\/skiprest` | src/server.mjs:906 |
| `GET` | `\/api\/acquire\/skiprest` | src/server.mjs:912 |
| `DELETE` | `\/api\/acquire\/ignored\/([0-9a-fA-F-]{36})` | src/server.mjs:914 |
| `DELETE` | `\/api\/acquire\/tracked\/scenes\/([0-9a-fA-F-]{36})` | src/server.mjs:919 |
| `GET` | `\/api\/library\/rails` | src/server.mjs:936 |
| `GET` | `\/api\/library\/feeds` | src/server.mjs:940 |
| `GET` | `\/api\/library\/overview` | src/server.mjs:944 |
| `GET` | `\/api\/library\/films` | src/server.mjs:947 |
| `GET` | `\/api\/library\/films\/lookup` | src/server.mjs:950 |
| `POST` | `\/api\/library\/films\/(group|film)\/(\d+)\/scrape` | src/server.mjs:956 |
| `POST` | `\/api\/library\/films\/(group|film)\/(\d+)\/apply` | src/server.mjs:963 |
| `POST` | `\/api\/library\/films\/(group|film)\/(\d+)\/delete` | src/server.mjs:967 |
| `GET` | `\/api\/library\/performers` | src/server.mjs:970 |
| `GET` | `\/api\/library\/studios` | src/server.mjs:972 |
| `GET` | `\/api\/library\/identify\/movies` | src/server.mjs:979 |
| `POST` | `\/api\/library\/identify\/covers` | src/server.mjs:983 |
| `POST` | `\/api\/library\/identify\/movies` | src/server.mjs:990 |
| `GET` | `\/api\/library\/groups\/urls` | src/server.mjs:993 |
| `POST` | `\/api\/library\/groups\/(\d+)\/scrape` | src/server.mjs:1002 |
| `POST` | `\/api\/library\/groups\/(\d+)\/apply` | src/server.mjs:1009 |
| `POST` | `\/api\/library\/groups\/(\d+)\/url` | src/server.mjs:1015 |
| `GET` | `\/api\/library\/in-flight` | src/server.mjs:1022 |
| `GET` | `\/api\/library\/stage\/([a-z]+)` | src/server.mjs:1025 |
| `GET` | `\/api\/tidy` | src/server.mjs:1035 |
| `POST` | `\/api\/tidy\/unmonitor` | src/server.mjs:1038 |
| `POST` | `\/api\/tidy\/remove` | src/server.mjs:1040 |
| `GET` | `\/api\/library\/gaps` | src/server.mjs:1046 |
| `GET` | `\/api\/library\/shelf` | src/server.mjs:1066 |
| `GET` | `\/api\/library\/list\/([a-z]+)` | src/server.mjs:1068 |
| `GET` | `\/api\/library\/categories` | src/server.mjs:1075 |
| `GET` | `\/api\/library\/categories\/terms` | src/server.mjs:1076 |
| `POST` | `\/api\/library\/categories\/preview` | src/server.mjs:1077 |
| `POST` | `\/api\/library\/categories` | src/server.mjs:1081 |
| `GET` | `\/api\/library\/categories\/([a-z0-9-]+)` | src/server.mjs:1086 |
| `POST` | `\/api\/library\/categories\/([a-z0-9-]+)` | src/server.mjs:1091 |
| `DELETE` | `\/api\/library\/categories\/([a-z0-9-]+)` | src/server.mjs:1093 |
| `POST` | `\/api\/library\/categories\/([a-z0-9-]+)\/refresh` | src/server.mjs:1097 |
| `DELETE` | `\/api\/library\/categories\/([a-z0-9-]+)\/art` | src/server.mjs:1100 |
| `POST` | `\/api\/library\/categories\/([a-z0-9-]+)\/scenes` | src/server.mjs:1103 |
| `POST` | `\/api\/library\/categories\/([a-z0-9-]+)\/order` | src/server.mjs:1105 |
| `GET` | `\/api\/library\/scenes\/(\d+)\/categories` | src/server.mjs:1109 |
| `GET` | `\/api\/library\/reel` | src/server.mjs:1113 |
| `GET` | `\/api\/library\/reel\/settings` | src/server.mjs:1180 |
| `POST` | `\/api\/library\/reel\/settings` | src/server.mjs:1182 |
| `GET` | `\/api\/library\/reel\/tags` | src/server.mjs:1194 |
| `GET` | `\/api\/reddit` | src/server.mjs:1197 |
| `GET` | `\/api\/markerclips` | src/server.mjs:1201 |
| `POST` | `\/api\/markerclips\/generate` | src/server.mjs:1203 |
| `GET` | `\/api\/redgifs` | src/server.mjs:1209 |
| `POST` | `\/api\/redgifs\/refresh` | src/server.mjs:1211 |
| `POST` | `\/api\/redgifs\/follow` | src/server.mjs:1216 |
| `POST` | `\/api\/redgifs\/unfollow` | src/server.mjs:1224 |
| `POST` | `\/api\/redgifs\/tags` | src/server.mjs:1229 |
| `POST` | `\/api\/redgifs\/tags\/remove` | src/server.mjs:1235 |
| `POST` | `\/api\/reddit\/follow` | src/server.mjs:1240 |
| `POST` | `\/api\/reddit\/unfollow` | src/server.mjs:1248 |
| `POST` | `\/api\/reddit\/refresh` | src/server.mjs:1253 |
| `GET` | `\/api\/library\/scenes\/(\d+)` | src/server.mjs:1259 |
| `GET` | `\/api\/library\/performers\/(\d+)` | src/server.mjs:1265 |
| `GET` | `\/api\/library\/performers\/(\d+)\/iafd` | src/server.mjs:1272 |
| `POST` | `\/api\/library\/performers\/(\d+)\/iafd` | src/server.mjs:1276 |
| `GET` | `\/api\/library\/studios\/(\d+)` | src/server.mjs:1280 |
| `GET` | `\/api\/library\/studios\/(\d+)\/facts` | src/server.mjs:1290 |
| `POST` | `\/api\/library\/studios\/(\d+)\/facts` | src/server.mjs:1293 |
| `GET` | `\/api\/library\/groups\/(\d+)` | src/server.mjs:1296 |
| `GET` | `\/api\/library\/galleries` | src/server.mjs:1305 |
| `GET` | `\/api\/library\/galleries\/gaps` | src/server.mjs:1316 |
| `GET` | `\/api\/library\/galleries\/(\d+)` | src/server.mjs:1319 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/organized` | src/server.mjs:1322 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/rating` | src/server.mjs:1325 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/title` | src/server.mjs:1329 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/cover` | src/server.mjs:1332 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/focus` | src/server.mjs:1335 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/ties` | src/server.mjs:1344 |
| `GET` | `\/api\/library\/lookup` | src/server.mjs:1352 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/rescan` | src/server.mjs:1364 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/images\/delete` | src/server.mjs:1375 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/delete` | src/server.mjs:1379 |
| `GET` | `\/api\/galleries\/setup` | src/server.mjs:1389 |
| `POST` | `\/api\/galleries\/setup` | src/server.mjs:1392 |
| `POST` | `\/api\/galleries\/find` | src/server.mjs:1394 |
| `POST` | `\/api\/galleries\/build` | src/server.mjs:1408 |
| `GET` | `\/api\/galleries\/jobs\/(\d+)` | src/server.mjs:1441 |
| `GET` | `\/api\/library\/search` | src/server.mjs:1447 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/activity` | src/server.mjs:1454 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/play` | src/server.mjs:1460 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/organized` | src/server.mjs:1468 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/rating` | src/server.mjs:1492 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/o` | src/server.mjs:1495 |
| `GET` | `\/api\/library\/scenes\/(\d+)\/downscale` | src/server.mjs:1502 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/downscale` | src/server.mjs:1505 |
| `GET` | `\/api\/library\/scenes\/(\d+)\/resolution` | src/server.mjs:1509 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/resolution` | src/server.mjs:1511 |
| `GET` | `\/api\/library\/catchup` | src/server.mjs:1521 |
| `POST` | `\/api\/library\/catchup` | src/server.mjs:1526 |
| `GET` | `\/api\/library\/downscale` | src/server.mjs:1530 |
| `GET` | `\/api\/library\/scenes\/(\d+)\/removal` | src/server.mjs:1532 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/delete` | src/server.mjs:1535 |
| `GET` | `\/api\/moviefiles` | src/server.mjs:1549 |
| `GET` | `\/api\/moviefiles\/([0-9a-f]{12})` | src/server.mjs:1552 |
| `POST` | `\/api\/moviefiles\/([0-9a-f]{12})\/activity` | src/server.mjs:1559 |
| `POST` | `\/api\/moviefiles\/([0-9a-f]{12})\/play` | src/server.mjs:1565 |
| `POST` | `\/api\/moviefiles\/([0-9a-f]{12})\/forget` | src/server.mjs:1567 |
| `GET` | `\/api\/moviefiles\/([0-9a-f]{12})\/candidates` | src/server.mjs:1570 |
| `POST` | `\/api\/moviefiles\/([0-9a-f]{12})\/metadata` | src/server.mjs:1576 |
| `GET` | `\/api\/whisparr3\/scenes\/([0-9a-fA-F-]{36})` | src/server.mjs:1599 |
| `POST` | `\/api\/whisparr3\/scenes\/([0-9a-fA-F-]{36})` | src/server.mjs:1602 |
| `POST` | `\/api\/whisparr3\/scenes\/([0-9a-fA-F-]{36})\/again` | src/server.mjs:1617 |
| `GET` | `\/api\/whisparr3\/queue` | src/server.mjs:1625 |

## Inside what is still large

`shelf.js` was 5,813 lines and is now a router over `public/library/`. These
two are what is left of that shape; the only structure they have is their banner
comments, so jump to a line rather than searching the file.



## Line counts

| File | Lines |
|---|---|
| src/server.mjs | 2324 |
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
