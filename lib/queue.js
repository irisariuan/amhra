class Queue extends Array{
	constructor(...arg) {
		super(...arg)
		this.called = 0;
	}
	next(isLoop=false) {
		this.called+=1;
		if (this.called >= this.length && isLoop) {	
			this.called = 0
		}
		return this.at(this.called);
	}
	getNext() {
		if (this.called >= this.length) {
			return false
		}
		return this.at(this.called+1);
	}
}
module.exports = { Queue }
