const { PrismaClient } = require('@prisma/client')
const { misc: { generateToken } } = require('../misc')

const prisma = new PrismaClient()

function newUser(id, token, refreshToken, refreshTokenExpiresAt) {
    return prisma.user.create({
        data: {
            accessToken: generateToken(36),
            id,
            refreshToken,
            token,
            refreshTokenExpiresAt,
        }
    })
}

function getUser(accessToken) {
    return prisma.user.findFirst({ where: { accessToken } })
}

function countUser(accessToken) {
    return prisma.user.count({ where: { accessToken } })
}

process.on('exit', async () => {
    await prisma.$disconnect()
})

module.exports = { newUser, getUser, prisma, countUser }