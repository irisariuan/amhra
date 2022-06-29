const yts = require('yt-search')

yts('https://www.youtube.com/playlist?list=PLUPOh9x7B9R5Py6r7K58Akxep6amb43OA').then(v => console.log(v))
yts({listId: 'PLUPOh9x7B9R5Py6r7K58Akxep6amb43OA'}).then(v => console.log(v))