# Where things live

**Generated — do not hand-edit.** Re-run after moving anything:

```
docker run --rm -v "$PWD:/app" -w /app tpdbarr-portal:latest node docs/make-map.mjs
```

Written 2026-09-22 from 65 files.

## Addresses

Every `#/` the front end answers, and what draws it. The library half is
served by `shelf.js` and claimed before `app.js` sees the address.

| Address | Draws it | Where |
|---|---|---|
| `#/binge/redgifs` | `gifs.show` | public/app.js:99 |
| `#/binge/reddit` | `social.show` | public/app.js:100 |
| `#/binge/plugin` | `showBingePlugin` | public/app.js:101 |
| `#/binge` | `reel.show` | public/app.js:102 |
| `#/import/video` | `showAcquire` | public/app.js:129 |
| `#/import/images` | `showImages` | public/app.js:130 |
| `#/catalogue/groups` | `showGroupBuilder` | public/app.js:141 |
| `#/catalogue/match` | `showMatch` | public/app.js:142 |
| `#/catalogue/wildcard` | `showWildcard` | public/app.js:143 |
| `#/catalogue/markers` | `showMarkerBuilder` | public/app.js:144 |
| `#/catalogue` | `showCatalogue` | public/app.js:145 |
| `#/import/tracked` | `showTracked` | public/app.js:146 |
| `#/import/integrations` | `showIntegrations` | public/app.js:147 |
| `#/import/console` | `showHome` | public/app.js:148 |
| `#/import/performers` | `showPerformers` | public/app.js:149 |
| `#/import` | `showOverview` | public/app.js:150 |
| `#/thanks` | `showThanks` | public/app.js:151 |
| `#/parameters/catchup` | `showCatchUp` | public/app.js:192 |
| `#/parameters/feed` | `showFeed` | public/app.js:193 |
| `#/parameters/galleries` | `showGallerySettings` | public/app.js:194 |
| `#/parameters/catalog` | `showCatalogSettings` | public/app.js:195 |
| `#/parameters/sending` | `showSending` | public/app.js:196 |
| `#/parameters/stash` | `showStash` | public/app.js:197 |
| `#/parameters` | `showConnections` | public/app.js:198 |
| `^#\/site\/(\d+)$` | `showSite` | public/app.js:75 |
| `'^#/scene/' + UUID + '$'` | `showScene` | public/app.js:78 |
| `'^#/performer/' + UUID + '$'` | `showPerformer` | public/app.js:81 |
| `'^#/movie/' + UUID + '$'` | `showMovie` | public/app.js:84 |
| `^#\/search\/(.+)$` | `showSearch` | public/app.js:89 |
| `#/stats` | `showStats` | public/shelf.js:29 |
| `#/library/categories` | `showCategories` | public/shelf.js:63 |
| `#/library` | `showOverview` | public/shelf.js:85 |
| `^#\/library\/scene\/(\d+)$` | `showScene` | public/shelf.js:31 |
| `^#\/library\/movie\/([0-9a-f]{12})$` | `showMovie` | public/shelf.js:36 |
| `^#\/library\/group\/(\d+)$` | `showGroup` | public/shelf.js:42 |
| `^#\/library\/performer\/(\d+)$` | `showPerformer` | public/shelf.js:45 |
| `^#\/library\/studio\/(\d+)$` | `showStudio` | public/shelf.js:48 |
| `^#\/library\/gallery\/(\d+)$` | `showGallery` | public/shelf.js:51 |
| `^#\/library\/list\/([a-z]+)$` | `showList` | public/shelf.js:54 |
| `^#\/library\/category\/([a-z0-9-]+)(?:\?(.*))?$` | `showCategory` | public/shelf.js:61 |
| `^#\/library\/(scenes|performers|studios|galleries)(?:\?(.*))?$` | `—` | public/shelf.js:69 |
| `^#\/library\/movies(?:\?(.*))?$` | `showMovies` | public/shelf.js:80 |
| `^#\/library\/stage\/([a-z]+)$` | `showStage` | public/shelf.js:82 |

## API

|  | Path | Where |
|---|---|---|
| `GET` | `\/api\/state` | src/server.mjs:140 |
| `GET` | `\/api\/home` | src/server.mjs:192 |
| `GET` | `\/api\/options` | src/server.mjs:202 |
| `POST` | `\/api\/config` | src/server.mjs:216 |
| `POST` | `\/api\/tilescale` | src/server.mjs:235 |
| `GET` | `\/api\/sites` | src/server.mjs:251 |
| `GET` | `\/api\/sites\/(\d+)` | src/server.mjs:256 |
| `GET` | `\/api\/scenes\/([0-9a-fA-F-]{36})` | src/server.mjs:262 |
| `GET` | `\/api\/performers\/([0-9a-fA-F-]{36})` | src/server.mjs:264 |
| `GET` | `\/api\/movies` | src/server.mjs:271 |
| `GET` | `\/api\/movies\/([0-9a-fA-F-]{36})` | src/server.mjs:278 |
| `GET` | `\/api\/creators` | src/server.mjs:280 |
| `GET` | `\/api\/sites\/(\d+)\/art` | src/server.mjs:283 |
| `POST` | `\/api\/add` | src/server.mjs:305 |
| `GET` | `\/api\/queue` | src/server.mjs:316 |
| `GET` | `\/api\/stashdb\/search` | src/server.mjs:344 |
| `GET` | `\/api\/stashdb\/scenes\/([0-9a-fA-F-]{36})` | src/server.mjs:355 |
| `GET` | `\/api\/stashdb\/bridge\/([0-9a-fA-F-]{36})` | src/server.mjs:371 |
| `GET` | `\/api\/import\/overview` | src/server.mjs:397 |
| `GET` | `\/api\/import\/integrations` | src/server.mjs:409 |
| `GET` | `\/api\/import\/backups` | src/server.mjs:416 |
| `POST` | `\/api\/import\/backups` | src/server.mjs:419 |
| `GET` | `\/api\/import\/images\/places` | src/server.mjs:426 |
| `GET` | `\/api\/import\/match\/sources` | src/server.mjs:445 |
| `GET` | `\/api\/import\/match\/sites` | src/server.mjs:450 |
| `GET` | `\/api\/import\/match` | src/server.mjs:453 |
| `GET` | `\/api\/catalogue\/overview` | src/server.mjs:485 |
| `GET` | `\/api\/catalogue\/scan` | src/server.mjs:496 |
| `POST` | `\/api\/catalogue\/scan` | src/server.mjs:499 |
| `GET` | `\/api\/catalogue\/scan\/(\d+)` | src/server.mjs:502 |
| `GET` | `\/api\/catalogue\/generate` | src/server.mjs:510 |
| `POST` | `\/api\/catalogue\/generate` | src/server.mjs:513 |
| `GET` | `\/api\/catalogue\/generate\/(\d+)` | src/server.mjs:516 |
| `GET` | `\/api\/manage\/scan` | src/server.mjs:524 |
| `POST` | `\/api\/manage\/scan` | src/server.mjs:527 |
| `GET` | `\/api\/manage\/scan\/(\d+)` | src/server.mjs:530 |
| `GET` | `\/api\/manage\/duplicates` | src/server.mjs:533 |
| `GET` | `\/api\/manage\/chores` | src/server.mjs:536 |
| `POST` | `\/api\/manage\/chores\/stop` | src/server.mjs:538 |
| `GET` | `\/api\/manage\/reshelve` | src/server.mjs:540 |
| `POST` | `\/api\/manage\/reshelve` | src/server.mjs:543 |
| `POST` | `\/api\/manage\/copies\/keep-better` | src/server.mjs:546 |
| `POST` | `\/api\/manage\/nfo\/(missing|all)` | src/server.mjs:549 |
| `POST` | `\/api\/manage\/thumbs\/(missing|all)` | src/server.mjs:552 |
| `GET` | `\/api\/import\/match\/phash` | src/server.mjs:563 |
| `POST` | `\/api\/import\/match\/phash` | src/server.mjs:566 |
| `GET` | `\/api\/import\/match\/phash\/(\d+)` | src/server.mjs:569 |
| `POST` | `\/api\/scenes\/(\d+)\/generate` | src/server.mjs:579 |
| `GET` | `\/api\/scenes\/(\d+)\/generate\/(\d+)` | src/server.mjs:582 |
| `GET` | `\/api\/import\/match\/(\d+)` | src/server.mjs:585 |
| `POST` | `\/api\/import\/match\/(\d+)` | src/server.mjs:591 |
| `POST` | `\/api\/import\/match\/(\d+)\/page` | src/server.mjs:616 |
| `POST` | `\/api\/import\/match\/(\d+)\/rename\/plan` | src/server.mjs:624 |
| `GET` | `\/api\/import\/wildcard\/sources` | src/server.mjs:644 |
| `GET` | `\/api\/import\/wildcard\/find` | src/server.mjs:647 |
| `GET` | `\/api\/import\/wildcard\/names` | src/server.mjs:656 |
| `POST` | `\/api\/import\/wildcard\/names` | src/server.mjs:669 |
| `GET` | `\/api\/import\/wildcard\/scene\/(\d+)` | src/server.mjs:676 |
| `GET` | `\/api\/(?:catalogue|import\/wildcard)\/frames\/(\d+)` | src/server.mjs:690 |
| `POST` | `\/api\/(?:catalogue|import\/wildcard)\/frames\/(\d+)` | src/server.mjs:693 |
| `POST` | `\/api\/import\/wildcard\/urls` | src/server.mjs:696 |
| `POST` | `\/api\/import\/wildcard\/ask` | src/server.mjs:699 |
| `POST` | `\/api\/import\/wildcard\/scene\/(\d+)` | src/server.mjs:702 |
| `POST` | `\/api\/import\/wildcard\/scene\/(\d+)\/rename\/plan` | src/server.mjs:715 |
| `POST` | `\/api\/import\/match\/(\d+)\/aside` | src/server.mjs:729 |
| `GET` | `\/api\/import\/match\/(\d+)\/rename` | src/server.mjs:737 |
| `POST` | `\/api\/import\/match\/(\d+)\/rename` | src/server.mjs:740 |
| `GET` | `\/api\/import\/tags` | src/server.mjs:743 |
| `POST` | `\/api\/import\/tags` | src/server.mjs:746 |
| `GET` | `\/api\/import\/groups` | src/server.mjs:759 |
| `POST` | `\/api\/import\/groups\/scan` | src/server.mjs:767 |
| `POST` | `\/api\/import\/groups\/titles` | src/server.mjs:777 |
| `GET` | `\/api\/import\/groups\/proposals` | src/server.mjs:780 |
| `POST` | `\/api\/import\/groups\/([^/]+)\/approve` | src/server.mjs:784 |
| `POST` | `\/api\/import\/groups\/([^/]+)\/decline` | src/server.mjs:789 |
| `POST` | `\/api\/import\/groups\/([^/]+)\/reconsider` | src/server.mjs:792 |
| `POST` | `\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)` | src/server.mjs:800 |
| `DELETE` | `\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)` | src/server.mjs:803 |
| `GET` | `\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)\/find` | src/server.mjs:807 |
| `POST` | `\/api\/import\/groups\/([^/]+)\/scenes\/([^/]+)\/find` | src/server.mjs:815 |
| `GET` | `\/api\/import\/markers` | src/server.mjs:825 |
| `GET` | `\/api\/import\/markers\/queue` | src/server.mjs:838 |
| `GET` | `\/api\/import\/markers\/all` | src/server.mjs:846 |
| `GET` | `\/api\/import\/markers\/tags` | src/server.mjs:856 |
| `GET` | `\/api\/import\/markers\/tags\/search` | src/server.mjs:859 |
| `GET` | `\/api\/import\/markers\/scene\/(\d+)` | src/server.mjs:862 |
| `POST` | `\/api\/import\/markers\/scene\/(\d+)` | src/server.mjs:865 |
| `POST` | `\/api\/import\/markers\/marker\/(\d+)` | src/server.mjs:875 |
| `DELETE` | `\/api\/import\/markers\/marker\/(\d+)` | src/server.mjs:886 |
| `GET` | `\/api\/import\/markers\/scene\/(\d+)\/sources` | src/server.mjs:894 |
| `GET` | `\/api\/import\/markers\/scene\/(\d+)\/strip` | src/server.mjs:902 |
| `POST` | `\/api\/import\/markers\/scene\/(\d+)\/strip` | src/server.mjs:904 |
| `DELETE` | `\/api\/import\/markers\/scene\/(\d+)\/strip` | src/server.mjs:917 |
| `GET` | `\/api\/import\/images\/galleries` | src/server.mjs:922 |
| `GET` | `\/api\/import\/images\/performers` | src/server.mjs:928 |
| `GET` | `\/api\/acquire\/search` | src/server.mjs:933 |
| `GET` | `\/api\/acquire\/lookup` | src/server.mjs:937 |
| `GET` | `\/api\/acquire\/chips` | src/server.mjs:944 |
| `GET` | `\/api\/acquire\/wildcard` | src/server.mjs:958 |
| `GET` | `\/api\/acquire\/prowlarr` | src/server.mjs:967 |
| `GET` | `\/api\/acquire\/monitored` | src/server.mjs:979 |
| `GET` | `\/api\/acquire\/manualdrop` | src/server.mjs:988 |
| `POST` | `\/api\/acquire\/manualdrop` | src/server.mjs:989 |
| `POST` | `\/api\/acquire\/prowlarr\/grab` | src/server.mjs:991 |
| `GET` | `\/api\/acquire\/rules` | src/server.mjs:1012 |
| `POST` | `\/api\/acquire\/rules` | src/server.mjs:1015 |
| `GET` | `\/api\/acquire\/tracked` | src/server.mjs:1018 |
| `POST` | `\/api\/acquire\/tracked` | src/server.mjs:1023 |
| `DELETE` | `\/api\/acquire\/tracked\/(performer|studio|tag)\/([0-9a-fA-F-]{36})` | src/server.mjs:1031 |
| `GET` | `\/api\/acquire\/release` | src/server.mjs:1049 |
| `POST` | `\/api\/acquire\/release` | src/server.mjs:1051 |
| `POST` | `\/api\/acquire\/release\/now` | src/server.mjs:1058 |
| `GET` | `\/api\/acquire\/tracked\/scenes` | src/server.mjs:1061 |
| `POST` | `\/api\/acquire\/tracked\/scenes` | src/server.mjs:1069 |
| `POST` | `\/api\/acquire\/tracked\/scenes\/backfill` | src/server.mjs:1077 |
| `POST` | `\/api\/acquire\/ignored` | src/server.mjs:1085 |
| `POST` | `\/api\/acquire\/ignored\/batch` | src/server.mjs:1096 |
| `POST` | `\/api\/acquire\/skiprest` | src/server.mjs:1103 |
| `GET` | `\/api\/acquire\/skiprest` | src/server.mjs:1111 |
| `DELETE` | `\/api\/acquire\/ignored\/([0-9a-fA-F-]{36})` | src/server.mjs:1113 |
| `DELETE` | `\/api\/acquire\/tracked\/scenes\/([0-9a-fA-F-]{36})` | src/server.mjs:1118 |
| `GET` | `\/api\/library\/rails` | src/server.mjs:1134 |
| `GET` | `\/api\/library\/feeds` | src/server.mjs:1143 |
| `GET` | `\/api\/library\/overview` | src/server.mjs:1149 |
| `GET` | `\/api\/library\/films` | src/server.mjs:1156 |
| `GET` | `\/api\/library\/films\/lookup` | src/server.mjs:1159 |
| `POST` | `\/api\/library\/films\/(group|film)\/(\d+)\/scrape` | src/server.mjs:1165 |
| `POST` | `\/api\/library\/films\/(group|film)\/(\d+)\/apply` | src/server.mjs:1172 |
| `POST` | `\/api\/library\/films\/(group|film)\/(\d+)\/delete` | src/server.mjs:1176 |
| `GET` | `\/api\/library\/performers` | src/server.mjs:1179 |
| `GET` | `\/api\/library\/studios` | src/server.mjs:1181 |
| `GET` | `\/api\/library\/identify\/movies` | src/server.mjs:1195 |
| `POST` | `\/api\/library\/identify\/covers` | src/server.mjs:1202 |
| `POST` | `\/api\/library\/identify\/movies` | src/server.mjs:1209 |
| `GET` | `\/api\/library\/groups\/urls` | src/server.mjs:1212 |
| `POST` | `\/api\/library\/groups\/(\d+)\/scrape` | src/server.mjs:1223 |
| `POST` | `\/api\/library\/groups\/(\d+)\/apply` | src/server.mjs:1230 |
| `POST` | `\/api\/library\/groups\/(\d+)\/url` | src/server.mjs:1240 |
| `GET` | `\/api\/library\/in-flight` | src/server.mjs:1251 |
| `GET` | `\/api\/library\/stage\/([a-z]+)` | src/server.mjs:1254 |
| `GET` | `\/api\/tidy` | src/server.mjs:1264 |
| `POST` | `\/api\/tidy\/unmonitor` | src/server.mjs:1267 |
| `POST` | `\/api\/tidy\/remove` | src/server.mjs:1269 |
| `GET` | `\/api\/library\/gaps` | src/server.mjs:1276 |
| `GET` | `\/api\/library\/shelf` | src/server.mjs:1303 |
| `GET` | `\/api\/library\/list\/([a-z]+)` | src/server.mjs:1305 |
| `GET` | `\/api\/library\/categories` | src/server.mjs:1314 |
| `GET` | `\/api\/library\/categories\/terms` | src/server.mjs:1315 |
| `POST` | `\/api\/library\/categories\/preview` | src/server.mjs:1316 |
| `POST` | `\/api\/library\/categories` | src/server.mjs:1320 |
| `GET` | `\/api\/library\/categories\/([a-z0-9-]+)` | src/server.mjs:1325 |
| `POST` | `\/api\/library\/categories\/([a-z0-9-]+)` | src/server.mjs:1330 |
| `DELETE` | `\/api\/library\/categories\/([a-z0-9-]+)` | src/server.mjs:1332 |
| `POST` | `\/api\/library\/categories\/([a-z0-9-]+)\/refresh` | src/server.mjs:1336 |
| `DELETE` | `\/api\/library\/categories\/([a-z0-9-]+)\/art` | src/server.mjs:1339 |
| `POST` | `\/api\/library\/categories\/([a-z0-9-]+)\/scenes` | src/server.mjs:1342 |
| `POST` | `\/api\/library\/categories\/([a-z0-9-]+)\/order` | src/server.mjs:1344 |
| `GET` | `\/api\/library\/scenes\/(\d+)\/categories` | src/server.mjs:1348 |
| `GET` | `\/api\/library\/reel` | src/server.mjs:1356 |
| `GET` | `\/api\/library\/reel\/settings` | src/server.mjs:1453 |
| `POST` | `\/api\/library\/reel\/settings` | src/server.mjs:1455 |
| `GET` | `\/api\/library\/reel\/tags` | src/server.mjs:1467 |
| `GET` | `\/api\/reddit` | src/server.mjs:1475 |
| `GET` | `\/api\/markerclips` | src/server.mjs:1482 |
| `POST` | `\/api\/markerclips\/generate` | src/server.mjs:1484 |
| `GET` | `\/api\/redgifs` | src/server.mjs:1490 |
| `POST` | `\/api\/redgifs\/refresh` | src/server.mjs:1492 |
| `POST` | `\/api\/redgifs\/follow` | src/server.mjs:1497 |
| `POST` | `\/api\/redgifs\/unfollow` | src/server.mjs:1505 |
| `POST` | `\/api\/redgifs\/tags` | src/server.mjs:1510 |
| `POST` | `\/api\/redgifs\/tags\/remove` | src/server.mjs:1516 |
| `POST` | `\/api\/reddit\/follow` | src/server.mjs:1521 |
| `POST` | `\/api\/reddit\/unfollow` | src/server.mjs:1529 |
| `POST` | `\/api\/reddit\/refresh` | src/server.mjs:1534 |
| `GET` | `\/api\/library\/scenes\/(\d+)` | src/server.mjs:1540 |
| `GET` | `\/api\/library\/performers\/(\d+)` | src/server.mjs:1547 |
| `GET` | `\/api\/library\/performers\/(\d+)\/iafd` | src/server.mjs:1560 |
| `POST` | `\/api\/library\/performers\/(\d+)\/iafd` | src/server.mjs:1569 |
| `GET` | `\/api\/library\/studios\/(\d+)` | src/server.mjs:1577 |
| `GET` | `\/api\/library\/studios\/(\d+)\/facts` | src/server.mjs:1593 |
| `POST` | `\/api\/library\/studios\/(\d+)\/facts` | src/server.mjs:1596 |
| `GET` | `\/api\/library\/groups\/(\d+)` | src/server.mjs:1599 |
| `GET` | `\/api\/library\/galleries` | src/server.mjs:1610 |
| `GET` | `\/api\/library\/galleries\/gaps` | src/server.mjs:1621 |
| `GET` | `\/api\/library\/galleries\/(\d+)` | src/server.mjs:1624 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/organized` | src/server.mjs:1627 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/rating` | src/server.mjs:1630 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/title` | src/server.mjs:1639 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/cover` | src/server.mjs:1642 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/focus` | src/server.mjs:1645 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/ties` | src/server.mjs:1657 |
| `GET` | `\/api\/library\/lookup` | src/server.mjs:1669 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/rescan` | src/server.mjs:1686 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/images\/delete` | src/server.mjs:1697 |
| `POST` | `\/api\/library\/galleries\/(\d+)\/delete` | src/server.mjs:1705 |
| `GET` | `\/api\/galleries\/setup` | src/server.mjs:1716 |
| `POST` | `\/api\/galleries\/setup` | src/server.mjs:1719 |
| `POST` | `\/api\/galleries\/find` | src/server.mjs:1721 |
| `POST` | `\/api\/galleries\/build` | src/server.mjs:1735 |
| `GET` | `\/api\/galleries\/jobs\/(\d+)` | src/server.mjs:1771 |
| `GET` | `\/api\/library\/search` | src/server.mjs:1777 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/activity` | src/server.mjs:1787 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/play` | src/server.mjs:1793 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/organized` | src/server.mjs:1813 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/rating` | src/server.mjs:1849 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/o` | src/server.mjs:1852 |
| `GET` | `\/api\/library\/scenes\/(\d+)\/downscale` | src/server.mjs:1865 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/downscale` | src/server.mjs:1868 |
| `GET` | `\/api\/library\/scenes\/(\d+)\/resolution` | src/server.mjs:1876 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/resolution` | src/server.mjs:1878 |
| `GET` | `\/api\/library\/catchup` | src/server.mjs:1890 |
| `POST` | `\/api\/library\/catchup` | src/server.mjs:1895 |
| `GET` | `\/api\/library\/downscale` | src/server.mjs:1899 |
| `GET` | `\/api\/library\/scenes\/(\d+)\/removal` | src/server.mjs:1901 |
| `POST` | `\/api\/library\/scenes\/(\d+)\/delete` | src/server.mjs:1904 |
| `GET` | `\/api\/moviefiles` | src/server.mjs:1918 |
| `GET` | `\/api\/moviefiles\/([0-9a-f]{12})` | src/server.mjs:1921 |
| `POST` | `\/api\/moviefiles\/([0-9a-f]{12})\/activity` | src/server.mjs:1932 |
| `POST` | `\/api\/moviefiles\/([0-9a-f]{12})\/play` | src/server.mjs:1938 |
| `POST` | `\/api\/moviefiles\/([0-9a-f]{12})\/forget` | src/server.mjs:1940 |
| `GET` | `\/api\/moviefiles\/([0-9a-f]{12})\/candidates` | src/server.mjs:1947 |
| `POST` | `\/api\/moviefiles\/([0-9a-f]{12})\/metadata` | src/server.mjs:1953 |
| `GET` | `\/api\/whisparr3\/scenes\/([0-9a-fA-F-]{36})` | src/server.mjs:1976 |
| `POST` | `\/api\/whisparr3\/scenes\/([0-9a-fA-F-]{36})` | src/server.mjs:1979 |
| `POST` | `\/api\/whisparr3\/scenes\/([0-9a-fA-F-]{36})\/again` | src/server.mjs:1993 |
| `GET` | `\/api\/whisparr3\/queue` | src/server.mjs:2001 |

## Inside what is still large

`shelf.js` was 5,813 lines and is now a router over `public/library/`. These
two are what is left of that shape; the only structure they have is their banner
comments, so jump to a line rather than searching the file.



## Line counts

| File | Lines |
|---|---|
| src/server.mjs | 2845 |
| public/markerbuilder.js | 1755 |
| public/library/categories.js | 1300 |
| public/library/galleries.js | 1235 |
| public/import/search.js | 1134 |
| public/css/140-import.css | 1134 |
| public/css/150-markers.css | 985 |
| public/library/scene.js | 967 |
| public/library/movies.js | 935 |
| public/css/120-binge.css | 789 |
| public/player.js | 759 |
| public/library/overview.js | 738 |
| public/import/tracked.js | 629 |
| public/css/010-chrome.css | 562 |
| public/library/core.js | 552 |
| public/library/tiles.js | 523 |
| public/import/cards.js | 517 |
| public/library/shelves.js | 498 |
| public/css/110-search.css | 465 |
| public/library/group.js | 459 |
| public/reel/controls.js | 448 |
| public/css/090-overview.css | 407 |
| public/markerfetch.js | 399 |
| public/markermanage.js | 389 |
| public/css/100-galleries.css | 377 |
| public/css/050-scene.css | 371 |
| public/reel/slides.js | 361 |
| public/library/tracked.js | 358 |
| public/css/160-categories.css | 341 |
| public/css/080-films.css | 323 |
| public/css/030-rails.css | 319 |
| public/app.js | 315 |
| public/catalogue.js | 313 |
| public/import/core.js | 312 |
| public/css/040-player.css | 281 |
| public/import/movies.js | 276 |
| public/import/site.js | 273 |
| public/import/images.js | 271 |
| public/reel.js | 261 |
| public/import/console.js | 252 |
| public/markertag.js | 240 |
| public/css/020-cards.css | 236 |
| public/library/performer.js | 221 |
| public/library/facts.js | 218 |
| public/library/studio.js | 217 |
| public/import/rules.js | 213 |
| public/import/integrations.js | 170 |
| public/import/performers.js | 162 |
| public/reel/config.js | 161 |
| public/reel/media.js | 160 |
| public/import/monitored.js | 147 |
| public/reel/gestures.js | 136 |
| public/import/send.js | 134 |
| public/reel/core.js | 132 |
| public/library/picture.js | 129 |
| public/import/thanks.js | 129 |
| public/import/overview.js | 121 |
| public/css/000-base.css | 116 |
| public/css/130-narrow.css | 109 |
| public/css/060-creators.css | 101 |
| public/css/070-facets.css | 100 |
| public/shelf.js | 88 |
| public/import/scene.js | 88 |
| public/reel/keeps.js | 62 |
| public/css/170-picture.css | 14 |
