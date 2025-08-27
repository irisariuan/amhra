export enum Permission {
	Admin = 1 << 1,
	User = 1 << 0,
	HasSettings = 1 << 2,
}
export function anyPerm(perm: number, requiredPerms: Permission[]) {
	for (const p of requiredPerms) {
		if ((perm & p) === p) return true;
	}
	return false;
}
export function allPerm(perm: number, requiredPerms: Permission[]) {
	for (const p of requiredPerms) {
		if ((perm & p) !== p) return false;
	}
	return true;
}
