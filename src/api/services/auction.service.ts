import moment from 'moment-timezone';
import { DB } from '../../../helper/package.helper';
import { auctionQueue } from '../workers/auction.worker';
import socketService from '../websocket/socket.service';
import logger from '../../../winston/logger';

class AuctionService {
    public async createAuction(data: any, creatorId: number) {
        try {
            const { title, description, startingPrice, endsAt } = data;

            // 1. Parse the input as IST
            const endsAtMoment = moment.tz(endsAt, 'Asia/Kolkata');
            const nowIST = moment.tz('Asia/Kolkata');

            if (!endsAtMoment.isAfter(nowIST)) {
                throw new Error(`EndsAt must be in the future. Current IST: ${nowIST.format('HH:mm:ss')}, Provided: ${endsAtMoment.format('HH:mm:ss')}`);
            }

            // 2. CRITICAL: To make the DB show "11:30" when it is 11:30 IST,
            // we remove the timezone offset before saving. This "tricks" the DB 
            // into storing the local time digits.
            const dateToSave = new Date(endsAtMoment.format('YYYY-MM-DDTHH:mm:ss') + 'Z');

            const auction = await DB.auctionItem.create({
                data: {
                    title,
                    description,
                    startingPrice,
                    currentPrice: startingPrice,
                    endsAt: dateToSave,
                    creatorId,
                    status: 'ACTIVE'
                }
            });

            // Schedule Settlement Job
            const delay = endsAtMoment.diff(nowIST);
            await auctionQueue.add('AUCTION_SETTLEMENT',
                { type: 'AUCTION_SETTLEMENT', auctionId: auction.id },
                {
                    delay: Math.max(0, delay),
                    jobId: `settlement_${auction.id}`,
                    removeOnComplete: true
                }
            );

            // Schedule Reminder (5 mins before)
            const reminderDelay = delay - (5 * 60 * 1000);
            if (reminderDelay > 0) {
                await auctionQueue.add('AUCTION_REMINDER',
                    { type: 'AUCTION_REMINDER', auctionId: auction.id },
                    {
                        delay: reminderDelay,
                        jobId: `reminder_${auction.id}`,
                        removeOnComplete: true
                    }
                );
            }

            // Return auction with consistent IST formatting
            return this.formatAuction(auction);
        } catch (error: any) {
            logger.error(`AuctionService.createAuction error: ${error.message}`);
            throw error;
        }
    }

    private formatAuction(auction: any) {
        return {
            ...auction,
            // Since we store endsAt local digits as UTC, we read them back as UTC 
            // to show the same digits to the user.
            endsAtIST: moment(auction.endsAt).utc().format('YYYY-MM-DD HH:mm:ss'),
            // createdAt is real UTC, so we convert it to IST display.
            createdAtIST: moment(auction.createdAt).tz('Asia/Kolkata').format('YYYY-MM-DD HH:mm:ss'),
        };
    }

    public async getAuctions(query: any) {
        try {
            const { status, page = 1, limit = 10 } = query;
            const skip = (Number(page) - 1) * Number(limit);

            const where: any = {};
            if (status) {
                where.status = status;
            }

            const [auctions, total] = await Promise.all([
                DB.auctionItem.findMany({
                    where,
                    skip,
                    take: Number(limit),
                    orderBy: { createdAt: 'desc' },
                    include: {
                        creator: {
                            select: { id: true, email: true }
                        }
                    }
                }),
                DB.auctionItem.count({ where })
            ]);

            return {
                auctions: auctions.map(a => this.formatAuction(a)),
                pagination: {
                    total,
                    page: Number(page),
                    limit: Number(limit),
                    totalPages: Math.ceil(total / Number(limit))
                }
            };
        } catch (error: any) {
            logger.error(`AuctionService.getAuctions error: ${error.message}`);
            throw error;
        }
    }

    public async getAuctionById(id: number) {
        try {
            const auction = await DB.auctionItem.findUnique({
                where: { id },
                include: {
                    creator: {
                        select: { id: true, email: true }
                    },
                    bids: {
                        take: 20,
                        orderBy: { createdAt: 'desc' },
                        include: {
                            bidder: {
                                select: { id: true, email: true }
                            }
                        }
                    }
                }
            });

            if (!auction) {
                throw new Error('Auction not found');
            }

            return this.formatAuction(auction);
        } catch (error: any) {
            logger.error(`AuctionService.getAuctionById error: ${error.message}`);
            throw error;
        }
    }

    public async placeBid(auctionId: number, bidderId: number, amount: number) {
        return await DB.$transaction(async (tx) => {
            // 1. Acquire Pessimistic Lock on the Auction Item
            const auctionResult: any[] = await tx.$queryRaw`
                SELECT * FROM auction_items 
                WHERE id = ${auctionId} 
                FOR UPDATE
            `;

            if (auctionResult.length === 0) {
                throw new Error('Auction not found');
            }

            const auction = auctionResult[0];

            // 2. Acquire Pessimistic Lock on the Bidder to prevent negative balance
            // Locking the bidder ensures that concurrent bids from the same user across different 
            // auctions are serialized, preventing the balance from going negative.
            const bidderResult: any[] = await tx.$queryRaw`
                SELECT * FROM users WHERE id = ${bidderId} FOR UPDATE
            `;

            if (bidderResult.length === 0) {
                throw new Error('Bidder not found');
            }

            const bidder = bidderResult[0];

            // 3. Temporal Validation (Inside the lock)
            if (auction.status.toUpperCase() !== 'ACTIVE' || new Date(auction.endsAt) <= new Date()) {
                throw new Error('Auction is not active or has expired');
            }

            // 4. Bid Amount Validation
            if (Number(amount) <= Number(auction.currentPrice)) {
                throw new Error('Bid must be higher than current price');
            }

            // 5. Bidder Balance Check (Inside the lock)
            if (Number(bidder.balance) < Number(amount)) {
                throw new Error('Insufficient balance');
            }

            // 7. 15-Second Rule: Every bid resets the timer to 15 seconds
            const nowIST = moment.tz('Asia/Kolkata');
            const updatedEndsAtMoment = nowIST.add(15, 'seconds');

            // Format for DB Sync (Local digits stored as UTC)
            const dateToSave = new Date(updatedEndsAtMoment.format('YYYY-MM-DDTHH:mm:ss') + 'Z');

            // 8. Update Auction Item
            const updatedAuction = await tx.auctionItem.update({
                where: { id: auctionId },
                data: {
                    currentPrice: amount,
                    winnerId: bidderId,
                    endsAt: dateToSave
                }
            });

            // 9. Create Bid Record
            const bid = await tx.bid.create({
                data: {
                    amount,
                    bidderId,
                    auctionItemId: auctionId
                }
            });

            // Schedule Outbid Notification if there was a previous winner
            if (auction.winnerId) {
                const previousWinner = await tx.user.findUnique({
                    where: { id: auction.winnerId }
                });
                if (previousWinner) {
                    await auctionQueue.add('OUTBID_NOTIFICATION', {
                        type: 'OUTBID_NOTIFICATION',
                        auctionId: auctionId,
                        bidderId: previousWinner.id,
                        bidderEmail: previousWinner.email,
                        amount: amount
                    }, {
                        removeOnComplete: true,
                        attempts: 3
                    });
                }
            }

            // Schedule a new settlement job for the new end time
            // We use a unique job ID based on the timestamp to ensure it's a new job
            const newDelay = updatedEndsAtMoment.diff(moment.tz('Asia/Kolkata'));
            await auctionQueue.add('AUCTION_SETTLEMENT',
                { type: 'AUCTION_SETTLEMENT', auctionId: auctionId },
                {
                    delay: Math.max(0, newDelay),
                    jobId: `settlement_${auctionId}_${updatedEndsAtMoment.valueOf()}`,
                    removeOnComplete: true
                }
            );

            const result = {
                bid,
                updatedAuction: this.formatAuction(updatedAuction)
            };

            // Emit NEW_BID event after transaction commit
            socketService.emitToAuction(auctionId, 'NEW_BID', {
                amount: amount,
                bidderName: bidder.email,
                timestamp: bid.createdAt
            });

            return result;
        });
    }
}

export default new AuctionService();
