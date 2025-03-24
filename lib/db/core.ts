import { PrismaClient } from '@prisma/client'
import { misc, globalApp, exp } from '../misc'

const prisma = new PrismaClient()

export async function newUser(id, token, tokenType, refreshToken, refreshTokenExpiresAt) {
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

export function getUser(accessToken) {
    return prisma.user.findFirst({ where: { accessToken: misc.removeBearer(accessToken) } })
}

export function countUser(accessToken) {
    return prisma.user.count({ where: { accessToken: misc.removeBearer(accessToken) } })
}

export async function hasUser(id) {
    return (await prisma.user.count({ where: { accessToken: id } })) > 0
}

process.on('exit', async () => {
    globalApp.important('Disconnecting from database')
    await prisma.$disconnect()
})
