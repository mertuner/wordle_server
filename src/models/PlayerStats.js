const { db } = require('../config/firebase');

class PlayerStats {
  static async getStats(userId) {
    const doc = await db.collection('playerStats').doc(userId).get();
    return doc.exists ? doc.data() : null;
  }

  static async createStats(userId, username) {
    const initialStats = {
      userId,
      username,
      gamesPlayed: 0,
      gamesWon: 0,
      currentStreak: 0,
      bestStreak: 0,
      rating: 1000, // Initial ELO rating
      averageGuesses: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await db.collection('playerStats').doc(userId).set(initialStats);
    return initialStats;
  }

  static async updateStats(userId, gameResult) {
    const statsRef = db.collection('playerStats').doc(userId);
    
    return db.runTransaction(async (transaction) => {
      const doc = await transaction.get(statsRef);
      if (!doc.exists) {
        throw new Error('Player stats not found');
      }

      const stats = doc.data();
      const updates = {
        gamesPlayed: stats.gamesPlayed + 1,
        gamesWon: stats.gamesWon + (gameResult.won ? 1 : 0),
        currentStreak: gameResult.won ? stats.currentStreak + 1 : 0,
        bestStreak: gameResult.won ? 
          Math.max(stats.bestStreak, stats.currentStreak + 1) : 
          stats.bestStreak,
        averageGuesses: (
          (stats.averageGuesses * stats.gamesPlayed + gameResult.guesses) / 
          (stats.gamesPlayed + 1)
        ).toFixed(2),
        updatedAt: new Date().toISOString()
      };

      // Update ELO rating if it was a multiplayer game
      if (gameResult.opponentRating) {
        const expectedScore = 1 / (1 + Math.pow(10, (gameResult.opponentRating - stats.rating) / 400));
        const actualScore = gameResult.won ? 1 : 0;
        const k = 32; // K-factor for ELO calculation
        updates.rating = Math.round(stats.rating + k * (actualScore - expectedScore));
      }

      transaction.update(statsRef, updates);
      return { ...stats, ...updates };
    });
  }

  static async getLeaderboard(limit = 10) {
    const snapshot = await db.collection('playerStats')
      .orderBy('rating', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => ({
      userId: doc.id,
      ...doc.data()
    }));
  }

  static async isUsernameAvailable(username) {
    const snapshot = await db.collection('playerStats')
      .where('username', '==', username)
      .limit(1)
      .get();
    
    return snapshot.empty;
  }

  static async updateUsername(userId, newUsername) {
    if (!userId || !newUsername) {
      throw new Error('Missing required fields');
    }

    const statsRef = db.collection('playerStats').doc(userId);
    
    // Get current stats to verify user exists
    const currentStats = await statsRef.get();
    if (!currentStats.exists) {
      throw new Error('User not found');
    }
    
    // First check if username is available
    const isAvailable = await this.isUsernameAvailable(newUsername);
    if (!isAvailable) {
      throw new Error('Username already taken');
    }
    
    try {
      // Update the username
      await statsRef.update({
        username: newUsername,
        updatedAt: new Date().toISOString()
      });
      
      // Get and return the updated stats
      const doc = await statsRef.get();
      return doc.data();
    } catch (error) {
      console.error('Error updating username:', error);
      throw new Error('Failed to update username');
    }
  }
}

module.exports = PlayerStats; 