function validateAIResponse(response) {
    try {
        const data = JSON.parse(response);

        return {
            reply: data.reply || "Sorry, I couldn't understand that 😊",

            intent: data.intent || "general",

            action: data.action || "none",

            leadScore: Number(data.leadScore) || 0,

            needsHuman: Boolean(data.needsHuman),

            appointmentRequested: Boolean(data.appointmentRequested),

            customerName: data.customerName || null,

            businessName: data.businessName || null,

            industry: data.industry || null,

            location: data.location || null,

            interestedService: data.interestedService || null,

            budget: data.budget || null,

            summary: data.summary || ""
        };

    } catch (err) {

        console.error("❌ Invalid AI JSON");
        console.error(err.message);

        return {

            reply: "Sorry, something went wrong. Please try again 😊",

            intent: "error",

            action: "none",

            leadScore: 0,

            needsHuman: false,

            appointmentRequested: false,

            customerName: null,

            businessName: null,

            industry: null,

            location: null,

            interestedService: null,

            budget: null,

            summary: ""

        };
    }
}

module.exports = validateAIResponse;