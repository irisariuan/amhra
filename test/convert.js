// const { OpusEncoder } = require('@discordjs/opus');
// const fs = require('fs');

// const encoder = new OpusEncoder(48000, 2);

// const arguments = process.argv.slice(2)

// if (arguments.length >= 2) {	
// 	fs.readFile(arguments[0], (err, d) => {
// 		if (err) return console.error(err);
// 		const decoded = encoder.decode(d)
// 		fs.writeFile(arguments[1], decoded, (e) => {
// 			if (err) return console.error(err);
// 			console.log("Sucess!")
// 		})
// 	})
// }
const prism = require('prism-media');
const fs = require('fs');

const decoder = new prism.opus.Decoder();

fs.createReadStream('./Aquabot Private Testing.opus', {})
.pipe(decoder)
.pipe(fs.createWriteStream('test.pcm'));

decoder.on('close', () => {
	console.log('closed')
})
decoder.on('data', (e) => {
	console.error(e)
})