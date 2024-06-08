const { PrismaClient } = require('@prisma/client')
const { misc: { generateToken, removeBearer }, globalApp, exp } = require('../misc')

const prisma = new PrismaClient()

async function newUser(id, token, tokenType, refreshToken, refreshTokenExpiresAt) {
    exp.log('Creating new user')
    if (await prisma.user.count({ where: { id } }) > 0) {
        exp.log('User exists, updating info...')
        return prisma.user.update({ where: { id }, data: { accessToken: generateToken(36), refreshToken, token, refreshTokenExpiresAt } })
    }
    return prisma.user.create({
        data: {
            accessToken: generateToken(36),
            id,
            refreshToken,
            token,
            refreshTokenExpiresAt,
            tokenType
        }
    })
}

function getUser(accessToken) {
    return prisma.user.findFirst({ where: { accessToken: removeBearer(accessToken)} })
}

function countUser(accessToken) {
    return prisma.user.count({ where: { accessToken: removeBearer(accessToken) } })
}

process.on('exit', async () => {
    globalApp.important('Disconnecting from database')
    await prisma.$disconnect()
})

module.exports = { newUser, getUser, prisma, countUser, removeBearer }