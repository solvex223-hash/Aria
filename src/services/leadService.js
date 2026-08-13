const db = require("../database/db");

async function saveLead(phone, lead) {

    return new Promise((resolve, reject) => {

        try {

            const stmt = db.prepare(`
                INSERT INTO leads (

                    phone,
                    name,
                    business,
                    industry,
                    location,
                    interested_service,
                    budget,
                    lead_score,
                    needs_human

                )

                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)

                ON CONFLICT(phone)
                DO UPDATE SET

                name = excluded.name,
                business = excluded.business,
                industry = excluded.industry,
                location = excluded.location,
                interested_service = excluded.interested_service,
                budget = excluded.budget,
                lead_score = excluded.lead_score,
                needs_human = excluded.needs_human,
                updated_at = CURRENT_TIMESTAMP

            `);

            stmt.run(

                phone,
                lead.name,
                lead.business,
                lead.industry,
                lead.location,
                lead.interestedService,
                lead.budget,
                lead.leadScore,
                lead.needsHuman ? 1 : 0

            );

            resolve();

        } catch (err) {

            reject(err);

        }

    });

}

module.exports = {

    saveLead

};