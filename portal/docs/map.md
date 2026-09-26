# Where things live

**Generated — do not hand-edit.** Re-run after moving anything:

```
docker run --rm -v "$PWD:/app" -w /app tpdbarr-portal:latest node docs/make-map.mjs
```

Written 2026-09-26 from 67 files.

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
| `#/stats` | `showStats` | public/shelf.js:27 |
| `#/library/categories` | `showCategories` | public/shelf.js:56 |
| `#/library` | `showOverview` | public/shelf.js:79 |
| `^#\/library\/scene\/(\d+)$` | `showScene` | public/shelf.js:29 |
| `^#\/library\/movie\/([0-9a-f]{12})$` | `showMovie` | public/shelf.js:34 |
| `^#\/library\/group\/(\d+)$` | `showGroup` | public/shelf.js:38 |
| `^#\/library\/performer\/(\d+)$` | `showPerformer` | public/shelf.js:41 |
| `^#\/library\/studio\/(\d+)$` | `showStudio` | public/shelf.js:44 |
| `^#\/library\/gallery\/(\d+)$` | `showGallery` | public/shelf.js:47 |
| `^#\/library\/list\/([a-z]+)$` | `showList` | public/shelf.js:50 |
| `^#\/library\/category\/([a-z0-9-]+)(?:\?(.*))?$` | `showCategory` | public/shelf.js:54 |
| `^#\/library\/tv(?:\?(.*))?$` | `showTv` | public/shelf.js:58 |
| `^#\/library\/(scenes|performers|studios|galleries)(?:\?(.*))?$` | `—` | public/shelf.js:63 |
| `^#\/library\/movies(?:\?(.*))?$` | `showMovies` | public/shelf.js:74 |
| `^#\/library\/stage\/([a-z]+)$` | `showStage` | public/shelf.js:76 |

## API

|  | Path | Where |
|---|---|---|
| `GET` | `\/api\/state` | src/server.mjs:130 |
| `GET` | `\/api\/home` | src/server.mjs:182 |
| `GET` | `\/api\/options` | src/server.mjs:192 |
| `POST` | `\/api\/config` | src/server.mjs:206 |
| `POST` | `\/api\/tilescale` | src/server.mjs:221 |
| `GET` | `\/api\/sites` | src/server.mjs:237 |
| `GET` | `\/api\/sites\/(\d+)` | src/server.mjs:242 |
| `GET` | `\/api\/scenes\/([0-9a-fA-F-]{36})` | src/server.mjs:248 |
| `GET` | `\/api\/performers\/([0-9a-fA-F-]{36})` | src/server.mjs:250 |
| `GET` | `\/api\/movies` | src/server.mjs:253 |
| `GET` | `\/api\/movies\/([0-9a-fA-F-]{36})` | src/server.mjs:260 |
| `GET` | `\/api\/creators` | src/server.mjs:262 |
| `GET` | `\/api\/sites\/(\d+)\/art` | src/server.mjs:265 |
| `POST` | `\/api\/add` | src/server.mjs:287 |
| `GET` | `\/api\/queue` | src/server.mjs:307 |
| `GET` | `\/api\/stashdb\/search` | src/server.mjs:331 |
| `GET` | `\/api\/stashdb\/scenes\/([0-9a-fA-F-]{36})` | src/server.mjs:342 |
| `GET` | `\/api\/stashdb\/bridge\/([0-9a-fA-F-]{36})` | src/server.mjs:355 |
| `GET` | `\/api\/import\/overview` | src/server.mjs:376 |
| `GET` | `\/api\/import\/integrations` | src/server.mjs:384 |
| `GET` | `\/api\/import\/backups` | src/server.mjs:387 |
| `POST` | `\/api\/import\/backups` | src/server.mjs:390 |
| `GET` | `\/api\/import\/images\/places` | src/server.mjs:393 |
| `GET` | `\/api\/import\/match\/sources` | src/server.mjs:404 |
| `GET` | `\/api\/import\/match\/sites` | src/server.mjs:409 |
| `GET` | `\/api\/import\/match` | src/server.mjs:412 |
| `GET` | `\/api\/catalogue\/overview` | src/server.mjs:438 |
| `GET` | `\/api\/catalogue\/scan` | src/server.mjs:442 |
| `POST` | `\/api\/catalogue\/scan` | src/server.mjs:445 |
| `GET` | `\/api\/catalogue\/scan\/(\d+)` | src/server.mjs:448 |
| `GET` | `\/api\/catalogue\/generate` | src/server.mjs:455 |
| `POST` | `\/api\/catalogue\/generate` | src/server.mjs:458 |
| `GET` | `\/api\/catalogue\/generate\/(\d+)` | src/server.mjs:461 |
| `GET` | `\/api\/manage\/scan` | src/server.mjs:465 |
| `POST` | `\/api\/manage\/scan` | src/server.mjs:468 |
| `GET` | `\/api\/manage\/scan\/(\d+)` | src/server.mjs:471 |
| `GET` | `\/api\/manage\/duplicates` | src/server.mjs:474 |
| `GET` | `\/api\/manage\/chores` | src/server.mjs:477 |
| `POST` | `\/api\/manage\/chores\/stop` | src/server.mjs:479 |
| `GET` | `\/api\/manage\/reshelve` | src/server.mjs:481 |
| `POST` | `\/api\/manage\/reshelve` | src/server.mjs:484 |
| `POST` | `\/api\/manage\/copies\/keep-better` | src/server.mjs:487 |
| `POST` | `\/api\/manage\/nfo\/(missing|all)` | src/server.mjs:490 |
| `POST` | `\/api\/manage\/thumbs\/(missing|all)` | src/server.mjs:493 |
| `GET` | `\/api\/import\/match\/phash` | src/server.mjs:497 |
| `POST` | `\/api\/import\/match\/phash` | src/server.mjs:500 |
| `GET` | `\/api\/import\/match\/phash\/(\d+)` | src/server.mjs:503 |
| `POST` | `\/api\/scenes\/(\d+)\/generate` | src/server.mjs:507 |
| `GET` | `\/api\/scenes\/(\d+)\/generate\/(\d+)` | src/server.mjs:510 |
| `GET` | `\/api\/import\/match\/(\d+)` | src/server.mjs:513 |
| `POST` | `\/api\/import\/match\/(\d+)` | src/server.mjs:519 |
| `POST` | `\/api\/import\/match\/(\d+)\/page` | src/server.mjs:538 |
| `POST` | `\/api\/import\/match\/(\d+)\/rename\/plan` | src/server.mjs:542 |
| `GET` | `\/api\/import\/wildcard\/sources` | src/server.mjs:556 |
| `GET` | `\/api\/import\/wildcard\/find` | src/server.mjs:559 |
| `GET` | `\/api\/import\/wildcard\/names` | src/server.mjs:566 |
| `POST` | `\/api\/import\/wildcard\/names` | src/server.mjs:574 |
| `GET` | `\/api\/import\/wildcard\/scene\/(\d+)` | src/server.mjs:581 |
| `GET` | `\/api\/(?:catalogue|import\/wildcard)\/frames\/(\d+)` | src/server.mjs:586 |
| `POST` | `\/api\/(?:catalogue|import\/wildcard)\/frames\/(\d+)` | src/server.mjs:589 |
| `POST` | `\/api\/import\/wildcard\/urls` | src/server.mjs:592 |
| `POST` | `\/api\/import\/wildcard\/ask` | src/server.mjs:595 |
| `POST` | `\/api\/import\/wildcard\/scene\/(\d+)` | src/server.mjs:598 |
| `POST` | `\/api\/import\/wildcard\/scene\/(\d+)\/rename\/plan` | src/server.mjs:604 |
| `POST` | `\/api\/import\/match\/(\d+)\/aside` | src/server.mjs:609 |
| `GET` | `\/api\/import\/match\/(\d+)\/rename` | src/server.mjs:613 |
| `POST` | `\/api\/import\/match\/(\d+)\/rename` | src/server.mjs:616 |
| `GET` | `\/api\/import\/tags` | src/server.mjs:619 |
| `POST` | `\/api\/import\/tags` | src/server.mjs:622 |
| `GET` | `\/api\/import\/groups` | src/server.mjs:634 |
| `POST` | `\/api\/import\/groups\/scan` | src/server.mjs:637 |
| `POST` | `\/api\/import\/groups\/titles` | src/server.mjs:643 |
| `GET` | `\/api\/import\/groups\/proposals` | src/server.mjs:646 |
| `POST` | `\/api\/import\/groups\/([^/]+)\/approve` | src/server.mjs:650 |
| `POST` | `\/api\/import\/groups\/([^/]+)\/decline` | src/server.mjs:655 |
| `POST` | `\/api\/import\/groups\/([^/]+)\/reconsider` | src/server.mjs:658 |
| `POST` | `\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)` | src/server.mjs:662 |
| `DELETE` | `\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)` | src/server.mjs:665 |
| `GET` | `\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)\/find` | src/server.mjs:669 |
| `POST` | `\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)\/find` | src/server.mjs:673 |
| `GET` | `\/api\/import\/markers` | src/server.mjs:681 |
| `GET` | `\/api\/import\/markers\/queue` | src/server.mjs:689 |
| `GET` | `\/api\/import\/markers\/all` | src/server.mjs:693 |
| `GET` | `\/api\/import\/markers\/tags` | src/server.mjs:703 |
| `GET` | `\/api\/import\/markers\/tags\/search` | src/server.mjs:706 |
| `GET` | `\/api\/import\/markers\/scene\/(\d+)` | src/server.mjs:709 |
| `POST` | `\/api\/import\/markers\/scene\/(\d+)` | src/server.mjs:712 |
| `POST` | `\/api\/import\/markers\/marker\/(\d+)` | src/server.mjs:722 |
| `DELETE` | `\/api\/import\/markers\/marker\/(\d+)` | src/server.mjs:733 |
| `GET` | `\/api\/import\/markers\/scene\/(\d+)\/sources` | src/server.mjs:737 |
| `GET` | `\/api\/import\/markers\/scene\/(\d+)\/strip` | src/server.mjs:741 |
| `POST` | `\/api\/import\/markers\/scene\/(\d+)\/strip` | src/server.mjs:743 |
| `DELETE` | `\/api\/import\/markers\/scene\/(\d+)\/strip` | src/server.mjs:756 |
| `GET` | `\/api\/import\/images\/galleries` | src/server.mjs:761 |
| `GET` | `\/api\/import\/images\/performers` | src/server.mjs:767 |
| `GET` | `\/api\/acquire\/search` | src/server.mjs:772 |
| `GET` | `\/api\/acquire\/lookup` | src/server.mjs:776 |
| `GET` | `\/api\/acquire\/chips` | src/server.mjs:783 |
| `GET` | `\/api\/acquire\/wildcard` | src/server.mjs:793 |
| `GET` | `\/api\/acquire\/prowlarr` | src/server.mjs:799 |
| `GET` | `\/api\/acquire\/monitored` | src/server.mjs:811 |
| `GET` | `\/api\/acquire\/manualdrop` | src/server.mjs:820 |
| `POST` | `\/api\/acquire\/manualdrop` | src/server.mjs:821 |
| `POST` | `\/api\/acquire\/prowlarr\/grab` | src/server.mjs:825 |
| `GET` | `\/api\/acquire\/rules` | src/server.mjs:841 |
| `POST` | `\/api\/acquire\/rules` | src/server.mjs:844 |
| `GET` | `\/api\/acquire\/tracked` | src/server.mjs:847 |
| `POST` | `\/api\/acquire\/tracked` | src/server.mjs:852 |
| `DELETE` | `\/api\/acquire\/tracked\/(performer|studio|tag)\/([0-9a-fA-F-]{36})` | src/server.mjs:860 |
| `GET` | `\/api\/acquire\/release` | src/server.mjs:871 |
| `POST` | `\/api\/acquire\/release` | src/server.mjs:873 |
| `POST` | `\/api\/acquire\/release\/now` | src/server.mjs:877 |
| `GET` | `\/api\/acquire\/tracked\/scenes` | src/server.mjs:880 |
| `POST` | `\/api\/acquire\/tracked\/scenes` | src/server.mjs:888 |
| `POST` | `\/api\/acquire\/tracked\/scenes\/backfill` | src/server.mjs:892 |
| `POST` | `\/api\/acquire\/ignored` | src/server.mjs:896 |
| `POST` | `\/api\/acquire\/ignored\/batch` | src/server.mjs:903 |
| `POST` | `\/api\/acquire\/skiprest` | src/server.mjs:907 |
| `GET` | `\/api\/acquire\/skiprest` | src/server.mjs:913 |
| `DELETE` | `\/api\/acquire\/ignored\/([0-9a-fA-F-]{36})` | src/server.mjs:915 |
| `DELETE` | `\/api\/acquire\/tracked\/scenes\/([0-9a-fA-F-]{36})` | src/server.mjs:920 |
| `GET` | `\/api\/library\/rails` | src/server.mjs:937 |
| `GET` | `\/api\/library\/feeds` | src/server.mjs:941 |
| `GET` | `\/api\/library\/overview` | src/server.mjs:945 |
| `GET` | `\/api\/library\/films` | src/server.mjs:948 |
| `GET` | `\/api\/library\/films\/lookup` | src/server.mjs:951 |
| `POST` | `\/api\/library\/films\/(group|film)\/(\d+)\/scrape` | src/server.mjs:957 |
| `POST` | `\/api\/library\/films\/(group|film)\/(\d+)\/apply` | src/server.mjs:964 |
| `POST` | `\/api\/library\/films\/(group|film)\/(\d+)\/delete` | src/server.mjs:968 |
| `GET` | `\/api\/library\/performers` | src/server.mjs:971 |
| `GET` | `\/api\/library\/studios` | src/server.mjs:973 |
| `GET` | `\/api\/library\/identify\/movies` | src/server.mjs:980 |
| `POST` | `\/api\/library\/identify\/covers` | src/server.mjs:984 |
| `POST` | `\/api\/library\/identify\/movies` | src/server.mjs:991 |
| `GET` | `\/api\/library\/groups\/urls` | src/server.mjs:994 |
| `POST` | `\/api\/library\/groups\/(\d+)\/scrape` | src/server.mjs:1003 |
| `POST` | `\/api\/library\/groups\/(\d+)\/apply` | src/server.mjs:1010 |
| `POST` | `\/api\/library\/groups\/(\d+)\/url` | src/server.mjs:1016 |
| `GET` | `\/api\/library\/in-flight` | src/server.mjs:1023 |
| `GET` | `\/api\/library\/stage\/([a-z]+)` | src/server.mjs:1026 |
| `GET` | `\/api\/tidy` | src/server.mjs:1036 |
| `POST` | `\/api\/tidy\/unmonitor` | src/server.mjs:1039 |
| `POST` | `\/api\/tidy\/remove` | src/server.mjs:1041 |
| `GET` | `\/api\/library\/gaps` | src/server.mjs:1047 |
| `GET` | `\/api\/library\/shelf` | src/server.mjs:1067 |
| `GET` | `\/api\/library\/tv\/channels` | src/server.mjs:1069 |
| `GET` | `\/api\/library\/tv` | src/server.mjs:1070 |
| `GET` | `\/api\/library\/list\/([a-z]+)` | src/server.mjs:1072 |
| `GET` | `\/api\/library\/categories` | src/server.mjs:1079 |
| `GET` | `\/api\/library\/categories\/terms` | src/server.mjs:1080 |
| `POST` | `\/api\/library\/categories\/preview` | src/server.mjs:1081 |
| `POST` | `\/api\/library\/categories` | src/server.mjs:1085 |
| `GET` | `\/api\/library\/categories\/([a-z0-9-]+)` | src/server.mjs:1090 |
| `POST` | `\/api\/library\/categories\/([a-z0-9-]+)` | src/server.mjs:1095 |
| `DELETE` | `\/api\/library\/categories\/([a-z0-9-]+)` | src/server.mjs:1097 |
| `POST` | `\/api\/library\/categories\/([a-z0-9-]+)\/refresh` | src/server.mjs:1101 |
| `DELETE` | `\/api\/library\/categories\/([a-z0-9-]+)\/art` | src/server.mjs:1104 |
| `POST` | `\/api\/library\/categories\/([a-z0-9-]+)\/scenes` | src/server.mjs:1107 |
| `POST` | `\/api\/library\/categories\/([a-z0-9-]+)\/order` | src/server.mjs:1109 |
| `GET` | `\/api\/library\/scenes\/(\d+)\/categories` | src/server.mjs:1113 |
| `GET` | `\/api\/library\/reel` | src/server.mjs:1117 |
| `GET` | `\/api\/library\/reel\/settings` | src/server.mjs:1184 |
| `POST` | `\/api\/library\/reel\/settings` | src/server.mjs:1186 |
| `GET` | `\/api\/library\/reel\/tags` | src/server.mjs:1198 |
| `GET` | `\/api\/reddit` | src/server.mjs:1201 |
| `GET` | `\/api\/markerclips` | src/server.mjs:1205 |
| `POST` | `\/api\/markerclips\/generate` | src/server.mjs:1207 |
| `GET` | `\/api\/redgifs` | src/server.mjs:1213 |
| `POST` | `\/api\/redgifs\/refresh` | src/server.mjs:1215 |
| `POST` | `\/api\/redgifs\/follow` | src/server.mjs:1220 |
| `POST` | `\/api\/redgifs\/unfollow` | src/server.mjs:1228 |
| `POST` | `\/api\/redgifs\/tags` | src/server.mjs:1233 |
| `POST` | `\/api\/redgifs\/tags\/remove` | src/server.mjs:1239 |
| `POST` | `\/api\/reddit\/follow` | src/server.mjs:1244 |
| `POST` | `\/api\/reddit\/unfollow` | src/server.mjs:1252 |
| `POST` | `\/api\/reddit\/refresh` | src/server.mjs:1257 |
| `GET` | `\/api\/library\/scenes\/(\d+)` | src/server.mjs:1263 |
| `GET` | `\/api\/library\/performers\/(\d+)` | src/server.mjs:1269 |
| `GET` | `\/api\/library\/performers\/(\d+)\/iafd` | src/server.mjs:1276 |
| `POST` | `\/api\/library\/performers\/(\d+)\/iafd` | src/server.mjs:1280 |
| `GET` | `\/api\/library\/studios\/(\d+)` | src/server.mjs:1284 |
| `GET` | `\/api\/library\/studios\/(\d+)\/facts` | src/server.mjs:1294 |
| `POST` | `\/api\/library\/studios\/(\d+)\/facts` | src/server.mjs:1297 |
| `GET` | `\/api\/library\/groups\/(\d+)` | src/server.mjs:1300 |
| `GET` | `\/api\/library\/galleries` | src/server.mjs:1309 |
| `GET` | `\/api\/library\/galleries\/gaps` | src/server.mjs:1320 |
| `GET` | `\/api\/library\/galleries\/(\d+)` | src/server.mjs:1323 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/organized` | src/server.mjs:1326 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/rating` | src/server.mjs:1329 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/title` | src/server.mjs:1333 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/cover` | src/server.mjs:1336 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/focus` | src/server.mjs:1339 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/ties` | src/server.mjs:1348 |
| `GET` | `\/api\/library\/lookup` | src/server.mjs:1356 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/rescan` | src/server.mjs:1368 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/images\/delete` | src/server.mjs:1379 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/delete` | src/server.mjs:1383 |
| `GET` | `\/api\/galleries\/setup` | src/server.mjs:1393 |
| `POST` | `\/api\/galleries\/setup` | src/server.mjs:1396 |
| `POST` | `\/api\/galleries\/find` | src/server.mjs:1398 |
| `POST` | `\/api\/galleries\/build` | src/server.mjs:1412 |
| `GET` | `\/api\/galleries\/jobs\/(\d+)` | src/server.mjs:1445 |
| `GET` | `\/api\/library\/search` | src/server.mjs:1451 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/activity` | src/server.mjs:1458 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/play` | src/server.mjs:1464 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/organized` | src/server.mjs:1472 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/rating` | src/server.mjs:1496 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/o` | src/server.mjs:1499 |
| `GET` | `\/api\/library\/scenes\/(\d+)\/downscale` | src/server.mjs:1506 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/downscale` | src/server.mjs:1509 |
| `GET` | `\/api\/library\/scenes\/(\d+)\/resolution` | src/server.mjs:1513 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/resolution` | src/server.mjs:1515 |
| `GET` | `\/api\/library\/catchup` | src/server.mjs:1525 |
| `POST` | `\/api\/library\/catchup` | src/server.mjs:1530 |
| `GET` | `\/api\/library\/downscale` | src/server.mjs:1534 |
| `GET` | `\/api\/library\/scenes\/(\d+)\/removal` | src/server.mjs:1536 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/delete` | src/server.mjs:1539 |
| `GET` | `\/api\/moviefiles` | src/server.mjs:1553 |
| `GET` | `\/api\/moviefiles\/([0-9a-f]{12})` | src/server.mjs:1556 |
| `POST` | `\/api\/moviefiles\/([0-9a-f]{12})\/activity` | src/server.mjs:1563 |
| `POST` | `\/api\/moviefiles\/([0-9a-f]{12})\/play` | src/server.mjs:1569 |
| `POST` | `\/api\/moviefiles\/([0-9a-f]{12})\/forget` | src/server.mjs:1571 |
| `GET` | `\/api\/moviefiles\/([0-9a-f]{12})\/candidates` | src/server.mjs:1574 |
| `POST` | `\/api\/moviefiles\/([0-9a-f]{12})\/metadata` | src/server.mjs:1580 |
| `GET` | `\/api\/whisparr3\/scenes\/([0-9a-fA-F-]{36})` | src/server.mjs:1603 |
| `POST` | `\/api\/whisparr3\/scenes\/([0-9a-fA-F-]{36})` | src/server.mjs:1606 |
| `POST` | `\/api\/whisparr3\/scenes\/([0-9a-fA-F-]{36})\/again` | src/server.mjs:1621 |
| `GET` | `\/api\/whisparr3\/queue` | src/server.mjs:1629 |

## Inside what is still large

`shelf.js` was 5,813 lines and is now a router over `public/library/`. These
two are what is left of that shape; the only structure they have is their banner
comments, so jump to a line rather than searching the file.



## Line counts

| File | Lines |
|---|---|
| src/server.mjs | 2328 |
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
| public/css/010-chrome.css | 534 |
| public/css/090-overview.css | 491 |
| public/library/tiles.js | 478 |
| public/import/tracked.js | 478 |
| public/import/cards.js | 472 |
| public/library/shelves.js | 459 |
| public/library/core.js | 433 |
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
| public/app.js | 279 |
| public/import/site.js | 270 |
| public/css/040-player.css | 269 |
| public/library/tv.js | 261 |
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
| public/css/130-narrow.css | 86 |
| public/import/scene.js | 85 |
| public/shelf.js | 82 |
| public/css/180-tv.css | 74 |
| public/reel/keeps.js | 47 |
| public/css/170-picture.css | 14 |
