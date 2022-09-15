const { songToStr } = require("./lib/voice");

let q = [{details:{durationInSec:3000}, title:'hello'},{details:{durationInSec:3000}, title:'hello'},{details:{durationInSec:3000}, title:'hello'}]

let s = q.slice(0, 6).reduce((old, n, i) => {
    old += songToStr(n, i)+'\n';
    return old;
}, '').slice(0, -2);

console.log(s)