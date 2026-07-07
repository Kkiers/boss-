var data = JSON.parse(window.__position_tree);
var config = data.zpData.config;
var result = [];
for (var i = 0; i < config.length; i++) {
  var cat = config[i];
  var catItem = {name: cat.name, code: cat.code, subLevelModelList: []};
  if (cat.subLevelModelList) {
    for (var j = 0; j < cat.subLevelModelList.length; j++) {
      var func = cat.subLevelModelList[j];
      var funcItem = {name: func.name, code: func.code, subLevelModelList: []};
      if (func.subLevelModelList) {
        for (var k = 0; k < func.subLevelModelList.length; k++) {
          var pos = func.subLevelModelList[k];
          funcItem.subLevelModelList.push({name: pos.name, code: pos.code});
        }
      }
      catItem.subLevelModelList.push(funcItem);
    }
  }
  result.push(catItem);
}
window.__position_tree_processed = JSON.stringify(result);
"Done: " + result.length + " categories";
