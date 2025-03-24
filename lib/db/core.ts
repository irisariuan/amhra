import { PrismaClient } from '@prisma/client'
import { misc, globalApp, exp } from '../misc'

const prisma = new PrismaClient()

export async function newUser(id: string, token: string, tokenType: string, refreshToken: string, refreshTokenExpiresAt: number) {
    exp.log('Creating new user')
    if (await prisma.user.count({ where: { id } }) > 0) {
        exp.log('User exists, updating info...')
        return prisma.user.update({ where: { id }, data: { accessToken: misc.generateToken(36), refreshToken, token, refreshTokenExpiresAt } })
    }
    return prisma.user.create({
        data: {
            accessToken: misc.generateToken(36),
            id,
            refreshToken,
            token,
            refreshTokenExpiresAt,
            tokenType
        }
    })
}

export function getUser(accessToken: string) {
    return prisma.user.findFirst({ where: { accessToken: misc.removeBearer(accessToken) } })
}

export function countUser(accessToken: string) {
    return prisma.user.count({ where: { accessToken: misc.removeBearer(accessToken) } })
}

export async function hasUser(accessToken: string) {
    return (await prisma.user.count({ where: { accessToken: accessToken } })) > 0
}

process.on('exit', async () => {
    globalApp.important('Disconnecting from database')
    await prisma.$disconnect()
})
