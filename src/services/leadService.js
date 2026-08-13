const db = require("../database/db");

async function saveLead(phone, lead) {

    return new Promise((resolve, reject) => {

        db.run(
            `
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

            `,
            [

                phone,
                lead.name,
                lead.business,
                lead.industry,
                lead.location,
                lead.interestedService,
                lead.budget,
                lead.leadScore,
                lead.needsHuman ? 1 : 0

            ],

            (err) => {

                if (err) return reject(err);

                resolve();

            }

        );

    });

}

module.exports = {

    saveLead

};