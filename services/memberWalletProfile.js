/**
 * Read-only member wallet identity for rewards / presale / admin review.
 * Wallet always comes from wallet-links.json via getVerifiedWalletForUser.
 */

const {
  getVerifiedWalletForUser,
  isWalletVerified,
  normalizeUserId,
} = require("./walletLinks");
const { isRewardEligible, countRewardsForUser } = require("./memberRewards");
const {
  getPresaleParticipation,
  getPresalePublicStatus,
} = require("./presaleParticipation");

function emptyRewardsSummary() {
  return { pending: 0, delivered: 0, cancelled: 0, mysteryPending: 0, total: 0 };
}

/**
 * @param {string|number} userId
 * @param {{ walletFile?: string, rewardsFile?: string, presaleFile?: string }} [options]
 */
function getMemberWalletProfile(userId, options = {}) {
  const telegramUserId = normalizeUserId(userId);
  const verifiedRecord = telegramUserId
    ? getVerifiedWalletForUser(telegramUserId, options.walletFile)
    : null;
  const verified = Boolean(verifiedRecord && verifiedRecord.wallet);
  const rewards = telegramUserId
    ? countRewardsForUser(telegramUserId, options.rewardsFile)
    : emptyRewardsSummary();
  const presale = getPresaleParticipation(telegramUserId, options.presaleFile);

  return {
    telegramUserId,
    wallet: verified ? verifiedRecord.wallet : null,
    verified,
    verifiedAt: verified ? verifiedRecord.verifiedAt : null,
    rewardEligible: telegramUserId
      ? isRewardEligible(telegramUserId, options.walletFile)
      : false,
    presale,
    rewards,
    presalePublic: getPresalePublicStatus(),
  };
}

module.exports = {
  getMemberWalletProfile,
  getVerifiedWalletForUser,
  isWalletVerified,
  isRewardEligible,
};
