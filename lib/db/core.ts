import { PrismaClient } from "@prisma/client";
import { globalApp } from "../misc";

export const prisma = new PrismaClient();

process.on("exit", async () => {
	globalApp.important("Disconnecting from database");
	await prisma.$disconnect();
});
